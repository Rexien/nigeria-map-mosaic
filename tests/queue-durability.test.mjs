import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteAnswerQueue } from '../gateway/lib/sqlite-queue.mjs';
import { BatchFlusher } from '../gateway/lib/batch-flusher.mjs';
import { createSupabaseSink } from '../gateway/server.mjs';

const answer = {participantId:'p',sessionId:'s',questionId:'q',optionIndex:0,idempotencyKey:'k'};

test('buffered duplicates wait for commit and retain first option', async () => {
  const q = new SQLiteAnswerQueue(':memory:', {groupCommitIntervalMs:1000});
  try {
    let settled = false;
    const first = q.enqueueAnswer(answer);
    const duplicate = q.enqueueAnswer({...answer,optionIndex:3}).then(r => {settled=true;return r;});
    await new Promise(r=>setTimeout(r,20));
    assert.equal(settled,false);
    assert.equal(q.getQueueDepth(),0);
    q.flushNow();
    const [a,b] = await Promise.all([first,duplicate]);
    assert.equal(a.answerId,b.answerId);
    assert.equal(b.duplicate,true);
    assert.equal(q.getQueuedBatch()[0].option_index,0);
  } finally {q.close();}
});

test('failed transaction rejects original and all buffered duplicates', async () => {
  const q = new SQLiteAnswerQueue(':memory:', {groupCommitIntervalMs:1000});
  const original = q.db.exec.bind(q.db);
  try {
    const results = Promise.allSettled([q.enqueueAnswer(answer),q.enqueueAnswer(answer),q.enqueueAnswer(answer)]);
    q.db.exec = sql => {if(sql==='COMMIT')throw new Error('injected disk failure');return original(sql);};
    q.flushNow();
    for(const result of await results)assert.equal(result.status,'rejected');
    assert.equal(q.getQueueDepth(),0);
  } finally {q.db.exec=original;q.close();}
});

test('drain deadline bounds a hung sink without overlapping or discarding writes', async () => {
  const q = new SQLiteAnswerQueue(':memory:',{groupCommitBatchSize:1});
  await q.enqueueAnswer(answer);
  let release;
  let calls=0;
  const f = new BatchFlusher(q,{sink:()=>{calls++;return new Promise(r=>{release=r;});}});
  try {
    await assert.rejects(f.drainQueue(30),/timeout/);
    assert.equal(q.getQueueDepth(),1);
    assert.equal(await f.flushOnce(),0);
    assert.equal(calls,1);
    release();
    await new Promise(r=>setTimeout(r,10));
    assert.equal(q.getQueueDepth(),0);
    assert.equal(await f.drainQueue(),true);
  } finally {q.close();}
});

test('Supabase request timeout retains queued answer and a later retry drains it', async () => {
  const q = new SQLiteAnswerQueue(':memory:',{groupCommitBatchSize:1});
  await q.enqueueAnswer(answer);
  const original=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async (_url,{signal})=>{
    calls++;
    if(calls>1)return {ok:true};
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  };
  const keepAlive=setInterval(()=>{},100);
  try {
    const f=new BatchFlusher(q,{sink:createSupabaseSink('https://test.invalid','test',{timeoutMs:20})});
    assert.equal(await f.flushOnce(),0);
    assert.equal(q.getQueueDepth(),1);
    assert.equal(await f.flushOnce(),1);
    assert.equal(q.getQueueDepth(),0);
  } finally {clearInterval(keepAlive);globalThis.fetch=original;q.close();}
});
