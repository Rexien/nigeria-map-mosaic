import test from 'node:test';
import assert from 'node:assert/strict';
import {handler} from '../server/api.mjs';

test('fallback uses hosted RPC contract and rejects wrong question without a write',async()=>{
  const original=globalThis.fetch;
  const oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL='https://fixture.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture';
  const session='00000000-0000-4000-8000-000000000001',question='00000000-0000-4000-8000-000000000002',key='00000000-0000-4000-8000-000000000003';
  const writes=[];
  globalThis.fetch=async(url,options={})=>{
    const path=new URL(url).pathname;
    let data;
    if(path.endsWith('/participants'))data=[{id:'p-fallback',event_id:'event'}];
    else if(path.endsWith('/live_sessions'))data=[{id:session,current_question_id:question,state:'open',deadline_at:new Date(Date.now()+60000).toISOString()}];
    else if(path.endsWith('/rpc/submit_raw_quiz_answer')){writes.push(JSON.parse(options.body));data={accepted:true,duplicate:true,answerId:'durable-id'};}
    else throw new Error(`Unexpected request ${path}`);
    return new Response(JSON.stringify(data),{status:200});
  };
  const event={httpMethod:'POST',path:'/api/answers',headers:{authorization:'Bearer fixture-token'}};
  try {
    const ok=await handler({...event,body:JSON.stringify({sessionId:session,questionId:question,idempotencyKey:key,optionIndex:2})});
    assert.equal(ok.statusCode,200);
    assert.equal(JSON.parse(ok.body).duplicate,true);
    assert.deepEqual(Object.keys(writes[0]).sort(),['p_token_hash','p_session_id','p_question_id','p_option_index','p_idempotency_key'].sort());
    assert.equal(writes[0].p_idempotency_key,key);
    assert.match(writes[0].p_token_hash,/^[0-9a-f]{64}$/);
    const wrong=await handler({...event,body:JSON.stringify({sessionId:session,questionId:key,idempotencyKey:key,optionIndex:2})});
    assert.equal(wrong.statusCode,409);
    assert.equal(writes.length,1);
  } finally {
    globalThis.fetch=original;
    if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;
    if(oldKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=oldKey;
  }
});
