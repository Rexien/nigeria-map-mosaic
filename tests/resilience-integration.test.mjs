import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as createHttpServer} from 'node:http';
import {SQLiteAnswerQueue} from '../gateway/lib/sqlite-queue.mjs';
import {createGatewayServer,refreshAuthorityState,setCachedEnvelope} from '../gateway/server.mjs';
import {createStateEnvelope} from '../lib/state-envelope.mjs';
import {signParticipantCredential} from '../lib/credentials.mjs';
import {globalMetrics} from '../lib/telemetry.mjs';
import {readFile} from 'node:fs/promises';

test('HTTP answer is acknowledged from SQLite and continuously flushed to the durable sink',async()=>{
  const queue=new SQLiteAnswerQueue(':memory:',{groupCommitIntervalMs:5,groupCommitBatchSize:10});
  const flushed=[];
  const server=createGatewayServer(queue,{sink:async items=>flushed.push(...items),allowedOrigin:'https://event.example'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const eventId='event-1',sessionId='11111111-1111-4111-8111-111111111111',questionId='22222222-2222-4222-8222-222222222222';
  setCachedEnvelope(createStateEnvelope({eventId,sessionId,state:'open',version:2,openedAt:new Date(Date.now()-500).toISOString(),deadlineAt:new Date(Date.now()+10000).toISOString()},{id:questionId,question:'Test?',options:['A','B','C','D']}));
  const credential=signParticipantCredential({participantId:'33333333-3333-4333-8333-333333333333',eventId});
  try{
    const response=await fetch(`${base}/gateway/answers`,{method:'POST',headers:{Origin:'https://event.example',Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:JSON.stringify({sessionId,questionId,optionIndex:2,idempotencyKey:'44444444-4444-4444-8444-444444444444'})});
    const result=await response.json();
    assert.equal(response.status,200);assert.equal(result.accepted,true);assert.ok(result.answerId);
    assert.equal(response.headers.get('access-control-allow-origin'),'https://event.example');
    const until=Date.now()+1000;while(flushed.length===0&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(flushed.length,1);assert.equal(flushed[0].question_id,questionId);assert.equal(queue.getQueueDepth(),0);
  }finally{await new Promise(resolve=>server.close(resolve));queue.close()}
});

test('gateway refreshes checksummed authority state and exposes live capacity health',async()=>{
  globalMetrics.reset();
  const authorityEnvelope=createStateEnvelope({eventId:'event-2',sessionId:'55555555-5555-4555-8555-555555555555',state:'lobby',version:7});
  const authority=createHttpServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(authorityEnvelope))});
  await new Promise(resolve=>authority.listen(0,'127.0.0.1',resolve));
  const authorityBase=`http://127.0.0.1:${authority.address().port}`;
  const queue=new SQLiteAnswerQueue(':memory:');
  const gateway=createGatewayServer(queue,{sink:async()=>{},startFlusher:false});
  await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  try{
    await refreshAuthorityState(authorityBase);
    const response=await fetch(`http://127.0.0.1:${gateway.address().port}/gateway/health`);
    const health=await response.json();
    assert.equal(health.currentVersion,7);assert.ok(health.capacity);assert.ok(['green','amber'].includes(health.capacity.status));
  }finally{
    await new Promise(resolve=>gateway.close(resolve));queue.close();
    await new Promise(resolve=>authority.close(resolve));
  }
});

test('production resilience wiring keeps secrets private and shared networks unblocked',async()=>{
  const [api,gateway,queue,migration,compose,caddy]=await Promise.all([
    readFile(new URL('../netlify/functions/api.mjs',import.meta.url),'utf8'),
    readFile(new URL('../gateway/server.mjs',import.meta.url),'utf8'),
    readFile(new URL('../gateway/lib/sqlite-queue.mjs',import.meta.url),'utf8'),
    readFile(new URL('../supabase/migrations/202609140001_snapshot_scoring.sql',import.meta.url),'utf8'),
    readFile(new URL('../gateway/docker-compose.yml',import.meta.url),'utf8'),
    readFile(new URL('../gateway/Caddyfile',import.meta.url),'utf8')
  ]);
  assert.match(api,/rateLimit\(p\.id,'answer'/);assert.match(api,/rpc\/submit_raw_quiz_answer/);assert.match(api,/gatewaySse: gatewayBase/);
  assert.doesNotMatch(api,/currentRequestId\s*=/);assert.doesNotMatch(gateway,/production'\?'[^']+'/);
  assert.match(queue,/synchronous = FULL/);assert.match(compose,/GATEWAY_PORT=3000/);assert.match(caddy,/reverse_proxy gateway:3000/);
  assert.match(migration,/create table if not exists public\.gateway_answers/i);
  assert.match(migration,/rank integer,/i);assert.doesNotMatch(migration,/create policy "Allow public read participant score snapshots"/i);
});
