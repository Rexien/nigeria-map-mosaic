import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {SQLiteAnswerQueue} from '../gateway/lib/sqlite-queue.mjs';
import {createGatewayServer,setCachedEnvelope} from '../gateway/server.mjs';
import {signParticipantCredential} from '../lib/credentials.mjs';
import {createStateEnvelope} from '../lib/state-envelope.mjs';

const participantCount=Math.max(1,Number(process.argv[2]||3000));
const answerWindowMs=Math.max(0,Number(process.env.ANSWER_WINDOW_MS??20000));
const print=console.log.bind(console);
const queue=new SQLiteAnswerQueue(':memory:',{groupCommitIntervalMs:15,groupCommitBatchSize:25});
const persisted=new Set();
const server=createGatewayServer(queue,{sink:async items=>items.forEach(item=>persisted.add(item.answer_id))});
const eventId='rehearsal-event',sessionId=crypto.randomUUID(),questionId=crypto.randomUUID();
setCachedEnvelope(createStateEnvelope({eventId,sessionId,state:'open',version:1,openedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+120000).toISOString()},{id:questionId,question:'Gateway rehearsal?',options:['A','B','C','D']}));

const percentile=(values,p)=>{
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.max(0,Math.ceil(sorted.length*p/100)-1)]||0;
};

try{
  await new Promise(resolve=>server.listen({port:0,host:'127.0.0.1',backlog:4096},resolve));
  const endpoint=`http://127.0.0.1:${server.address().port}/gateway/answers`;
  console.log=()=>{};
  const started=performance.now();
  const results=await Promise.all(Array.from({length:participantCount},async(_,index)=>{
    const credential=signParticipantCredential({participantId:crypto.randomUUID(),eventId});
    if(answerWindowMs)await new Promise(resolve=>setTimeout(resolve,Math.random()*answerWindowMs));
    const before=performance.now();
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:JSON.stringify({sessionId,questionId,optionIndex:index%4,idempotencyKey:crypto.randomUUID()})});
      return {status:response.status,latency:performance.now()-before};
    }catch(error){return {status:0,latency:performance.now()-before,error:error.cause?.code||error.code||error.message}}
  }));
  await server.flusher.drainQueue(10000);
  const latencies=results.map(result=>result.latency),accepted=results.filter(result=>result.status===200).length;
  const totalMs=performance.now()-started,p95=percentile(latencies,95),p99=percentile(latencies,99);
  const failures=results.filter(result=>result.status!==200),failureReasons=Object.groupBy(failures,result=>result.error||`HTTP_${result.status}`);
  print(JSON.stringify({participants:participantCount,answerWindowMs,accepted,failed:failures.length,failureReasons:Object.fromEntries(Object.entries(failureReasons).map(([key,value])=>[key,value.length])),persisted:persisted.size,queueDepth:queue.getQueueDepth(),totalMs:Number(totalMs.toFixed(2)),p50Ms:Number(percentile(latencies,50).toFixed(2)),p95Ms:Number(p95.toFixed(2)),p99Ms:Number(p99.toFixed(2))},null,2));
  if(accepted!==participantCount||persisted.size!==participantCount||queue.getQueueDepth()!==0||p95>2000)process.exitCode=1;
}finally{
  await new Promise(resolve=>server.close(resolve));
  queue.close();
}
