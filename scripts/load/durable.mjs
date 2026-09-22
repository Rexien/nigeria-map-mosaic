// Read-only reconciliation. No service-role key is written to evidence files.
export function reconcileAnswers(attempts, rows) {
  const errors=[];
  const first=attempts.filter(a=>a.attemptKind==='first');
  for(const a of first) {
    const matches=rows.filter(r=>r.participant_id===a.participantId && r.question_id===a.questionId);
    if(matches.length!==1){errors.push(`${a.participantId}: expected one durable row, found ${matches.length}`);continue;}
    const r=matches[0];
    if(r.option_index!==a.optionIndex)errors.push(`${a.participantId}: durable option mismatch`);
    if(r.session_id!==a.sessionId)errors.push(`${a.participantId}: durable session mismatch`);
    if(a.accepted && a.answerId && r.id!==a.answerId)errors.push(`${a.participantId}: accepted answer ID mismatch`);
  }
  for(const a of attempts.filter(a=>a.accepted)) {
    if(!rows.some(r=>r.participant_id===a.participantId && r.question_id===a.questionId && (!a.answerId || r.id===a.answerId)))errors.push(`${a.participantId}: accepted receipt missing from durable rows`);
  }
  return {passed:errors.length===0,expected:first.length,durable:rows.length,errors};
}

export async function verifyDurableAnswers(attempts,env=process.env) {
  if(!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)throw new Error('Durable verification requires server-side Supabase credentials');
  const ids=[...new Set(attempts.map(a=>a.participantId))];
  const questions=[...new Set(attempts.map(a=>a.questionId))];
  if(!ids.length || questions.length!==1)throw new Error('Expected a nonempty single-question attempt ledger');
  const rows=[];
  for(let i=0;i<ids.length;i+=50) {
    const url=new URL('/rest/v1/gateway_answers',env.SUPABASE_URL);
    url.searchParams.set('participant_id',`in.(${ids.slice(i,i+50).join(',')})`);
    url.searchParams.set('question_id',`eq.${questions[0]}`);
    url.searchParams.set('select','id,participant_id,session_id,question_id,option_index,response_ms');
    const response=await fetch(url,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`},signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!response.ok)throw new Error(`Durable read failed: HTTP ${response.status}`);
    rows.push(...await response.json());
  }
  return {...reconcileAnswers(attempts,rows),rows};
}
