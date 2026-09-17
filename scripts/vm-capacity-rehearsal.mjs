// Isolated loopback rehearsal: real gateway/WAL; local sink, not production Supabase.
// Run under OS memory/CPU limits. Generator shares the service budget intentionally.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createGatewayServer, broadcastState } from '../gateway/server.mjs';
import { SQLiteAnswerQueue } from '../gateway/lib/sqlite-queue.mjs';
import { createStateEnvelope } from '../lib/state-envelope.mjs';
import { signParticipantCredential } from '../lib/credentials.mjs';

const out = console.log;
console.log = () => {}; // Avoid per-answer logging dominating the synthetic test.
const pause = ms => new Promise(r => setTimeout(r, ms));
const queue = new SQLiteAnswerQueue('rehearsal-queue.db');
const sink = new DatabaseSync('rehearsal-sink.db');
sink.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS answers(id TEXT PRIMARY KEY)');
const insert = sink.prepare('INSERT OR IGNORE INTO answers VALUES (?)');
const server = createGatewayServer(queue, { sink: async rows => {
  sink.exec('BEGIN');
  try { for (const row of rows) insert.run(row.answer_id); sink.exec('COMMIT'); }
  catch (e) { sink.exec('ROLLBACK'); throw e; }
}});
await new Promise(r => server.listen(0, '127.0.0.1', 4096, r));
const port = server.address().port;
const agent = new http.Agent({keepAlive:true, maxSockets:3500});
let version=1, streams=[], peakRss=0, minAvailable=Infinity, aborted=false;
const report = value => out(JSON.stringify(value));
function safety() {
  const available=Number(fs.readFileSync('/proc/meminfo','utf8').match(/MemAvailable:\s+(\d+)/)[1])/1024;
  minAvailable=Math.min(minAvailable,available);
  peakRss=Math.max(peakRss,process.memoryUsage().rss/1048576);
  const active=execFileSync('systemctl',['is-active','eplbot'],{encoding:'utf8'}).trim();
  if(available<128 || active!=='active') throw new Error(`Safety stop: available=${available}, Footy=${active}`);
}
const guard=setInterval(()=>{try{safety()}catch(e){report({safetyStop:e.message});process.exit(2)}},2000);
function post(route,body,token) {
  return new Promise(resolve=>{
    const start=performance.now();
    const req=http.request({host:'127.0.0.1',port,path:route,method:'POST',agent,
      headers:{'content-type':'application/json',authorization:`Bearer ${token}`}},res=>{
      let text='';res.on('data',b=>text+=b);res.on('end',()=>{let data;try{data=JSON.parse(text)}catch{data={}}resolve({status:res.statusCode,data,ms:performance.now()-start})});
    });
    req.setTimeout(10000,()=>req.destroy(new Error('timeout')));
    req.on('error',e=>resolve({status:0,error:e.message,ms:performance.now()-start}));req.end(JSON.stringify(body));
  });
}
try {
  for(const n of [100,250,500,1000,1500,2000,2500,3000]) {
    safety(); peakRss=0;minAvailable=Infinity;
    const clients=Array.from({length:n},()=>({versions:new Set(),receivedAt:new Map(),token:signParticipantCredential({eventId:'isolated-capacity-test',participantId:crypto.randomUUID()}),key:crypto.randomUUID()}));
    for(let i=0;i<n;i+=50) {
      await Promise.all(clients.slice(i,i+50).map(c=>new Promise((resolve,reject)=>{
        const req=http.get({host:'127.0.0.1',port,path:'/gateway/stream',agent:false},res=>{
          let pending='';res.on('data',b=>{pending+=b;let index;while((index=pending.indexOf('\n\n'))>=0){const event=pending.slice(0,index);pending=pending.slice(index+2);const id=event.match(/^id: (\d+)/m);if(id){const v=Number(id[1]);c.versions.add(v);c.receivedAt.set(v,performance.now());resolve()}}});
        });
        req.setTimeout(15000,()=>req.destroy(new Error('stream timeout')));req.on('error',reject);streams.push(req);
      })));
    }
    const rounds=[];
    for(let round=0;round<3;round++) {
      for (const c of clients) c.key=crypto.randomUUID();
      const questionId=crypto.randomUUID(),sessionId=crypto.randomUUID();
      const state={eventId:'isolated-capacity-test',sessionId,version:++version,state:'open',openedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+30000).toISOString(),question:{id:questionId,question:'Isolated capacity test',options:['A','B','C','D']}};
      const sent=performance.now();broadcastState(createStateEnvelope(state));await pause(300);
      const answers=await Promise.all(clients.map((c,i)=>new Promise(resolve=>setTimeout(async()=>resolve(await post('/gateway/answers',{questionId,sessionId,optionIndex:i%4,idempotencyKey:c.key},c.token)),(i%100)*20))));
      const lat=answers.map(a=>a.ms).sort((a,b)=>a-b);
      const duplicates=await Promise.all(clients.slice(0,10).map(c=>post('/gateway/answers',{questionId,sessionId,optionIndex:0,idempotencyKey:c.key},c.token)));
      const drainStart=performance.now();
      const locked=createStateEnvelope({...state,state:'locked',version:++version});
      const drained=await post('/gateway/lock-and-drain',locked,'dev-gateway-secret');
      const drainMs=performance.now()-drainStart;
      const late=await post('/gateway/answers',{questionId,sessionId,optionIndex:0,idempotencyKey:crypto.randomUUID()},clients[0].token);
      const revealVersion=++version;broadcastState(createStateEnvelope({...state,state:'revealed',version:revealVersion}));await pause(300);
      const received=clients.filter(c=>c.versions.has(state.version)&&c.versions.has(revealVersion)).length;
      const accepted=answers.filter(a=>a.status===200&&a.data.accepted&&!a.data.duplicate).length;
      const row={round:round+1,accepted,received,p95Ms:Math.round(lat[Math.floor(n*.95)]),p99Ms:Math.round(lat[Math.floor(n*.99)]),broadcastMaxMs:Math.round(Math.max(...clients.map(c=>(c.receivedAt.get(state.version)||Infinity)-sent))),drainMs:Math.round(drainMs),drained:drained.status===200,duplicatesIgnored:duplicates.filter(a=>a.data.duplicate).length,lateRejected:late.status===409,queueDepth:queue.getQueueDepth()};
      rounds.push(row);
      if(accepted!==n||received!==n||row.p95Ms>2000||!row.drained||row.duplicatesIgnored!==10||!row.lateRejected){aborted=true;break;}
    }
    safety();report({players:n,rounds,peakProcessRssMiB:Math.round(peakRss),minHostAvailableMiB:Math.round(minAvailable),persisted:sink.prepare('SELECT COUNT(*) AS n FROM answers').get().n,passed:!aborted,scope:'loopback, generator shares limits, local durable sink, no TLS or Supabase'});
    for(const req of streams)req.destroy();streams=[];agent.destroy();await pause(1000);
    if(aborted)break;
  }
} catch(e) {report({error:e.stack});process.exitCode=1;}
finally {clearInterval(guard);for(const req of streams)req.destroy();agent.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));queue.close();sink.close();}
if(aborted)process.exitCode=1;
