import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {submitAnswer} from '../scripts/load/client-worker.mjs';
import {SSEObserverPool} from '../scripts/load/sse-observer.mjs';
import {reconcileAnswers} from '../scripts/load/durable.mjs';
import {rehearsalAlias} from '../scripts/load/prepare.mjs';

test('rehearsal aliases remain valid for long run IDs',()=>{
  const alias=rehearsalAlias('phase2-smoke-20260922-155509',1);
  assert.ok(alias.length>=2 && alias.length<=30);
  assert.match(alias,/[\p{L}\p{N}]/u);
});

test('HTTP 409 is not automatically a duplicate; attempt identity is preserved',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'Answer window closed'}),{status:409});
  try {
    const result=await submitAnswer({gatewayUrl:'https://test.invalid',participant:{id:'p',credential:'fixture'},questionId:'q',sessionId:'s',optionIndex:1,isDuplicate:true});
    assert.equal(result.duplicate,false);
    assert.equal(result.accepted,false);
    assert.equal(result.attemptKind,'retry');
    assert.equal(result.optionIndex,1);
  } finally {globalThis.fetch=original;}
});

test('network failure fallback preserves the exact answer identity and payload',async()=>{
  const original=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async(url,options)=>{
    calls.push({url:String(url),body:JSON.parse(options.body),headers:options.headers});
    if(calls.length===1)throw Object.assign(new Error('connection lost'),{code:'ECONNRESET'});
    return new Response(JSON.stringify({recorded:true,accepted:true,duplicate:false,answerId:'durable'}),{status:200});
  };
  try {
    const participant={id:'p',credential:'signed',token:'opaque'};
    const result=await submitAnswer({gatewayUrl:'https://gateway.invalid',fallbackUrl:'https://authority.invalid',participant,sessionId:'s',questionId:'q',optionIndex:3,existingKey:'00000000-0000-4000-8000-000000000003',bypassSecret:'fixture'});
    assert.equal(result.routedTo,'fallback');
    assert.equal(result.accepted,true);
    assert.equal(result.answerId,'durable');
    assert.deepEqual(calls[1].body,{sessionId:'s',questionId:'q',optionIndex:3,idempotencyKey:'00000000-0000-4000-8000-000000000003'});
    assert.equal(calls[1].headers.Authorization,'Bearer opaque');
    assert.equal(calls[1].headers['x-vercel-protection-bypass'],'fixture');
  } finally {globalThis.fetch=original;}
});

test('durable reconciliation rejects lost, changed and conflicting accepted answers',()=>{
  const attempt={participantId:'p',questionId:'q',sessionId:'s',optionIndex:1,accepted:true,answerId:'a',attemptKind:'first'};
  const row={id:'a',participant_id:'p',question_id:'q',session_id:'s',option_index:1};
  assert.equal(reconcileAnswers([attempt],[row]).passed,true);
  assert.equal(reconcileAnswers([attempt],[]).passed,false);
  assert.equal(reconcileAnswers([attempt],[{...row,option_index:2}]).passed,false);
  assert.equal(reconcileAnswers([attempt],[{...row,id:'other'}]).passed,false);
  assert.equal(reconcileAnswers([attempt],[row,row]).passed,false);
});

test('fanout measures command-to-receipt and counts each participant once',()=>{
  const pool=new SSEObserverPool();
  pool.commandStarts.set(2,1000);
  pool.eventsReceived=[{participantId:'a',version:2,receivedAt:1200},{participantId:'a',version:2,receivedAt:1201},{participantId:'b',version:2,receivedAt:1300}];
  const stats=pool.getFanoutStats(2);
  assert.equal(stats.receivedCount,2);
  assert.equal(stats.p95Ms,300);
  assert.equal(stats.measurement,'command-to-receipt');
});

test('SSE parses events split across network chunks and stop closes sockets',async()=>{
  const server=http.createServer((_req,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('event: state\n');
    setTimeout(()=>res.write('data: {"version":2,"state":"open"}\n'),20);
    setTimeout(()=>res.write('\n'),40);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const pool=new SSEObserverPool({gatewayUrl:`http://127.0.0.1:${server.address().port}`,participants:[{id:'p'}]});
  try {
    await pool.start();
    await pool.waitForConnections(1,1000);
    const until=Date.now()+1000;
    while(!pool.eventsReceived.length && Date.now()<until)await new Promise(r=>setTimeout(r,10));
    assert.equal(pool.eventsReceived[0]?.version,2);
    assert.equal(pool.eventsReceived[0]?.event,'state');
  } finally {
    pool.stop();
    assert.equal(pool.requests.size,0);
    server.closeAllConnections();
    await new Promise(r=>server.close(r));
  }
});
