import crypto from 'node:crypto';
import { db, event, verifyAdmin } from './_db.mjs';

const json = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers }, body: JSON.stringify(body) });
const clean = value => String(value ?? '').trim().replace(/\s+/g,' ').replace(/[<>\u0000-\u001f\u007f]/g,'');
const hash = value => crypto.createHash('sha256').update(`${process.env.PARTICIPANT_TOKEN_PEPPER || ''}:${value}`).digest('hex');
const token = bytes => crypto.randomBytes(bytes).toString('base64url');
const code = () => `${token(3).slice(0,4)}-${token(3).slice(0,4)}`.toUpperCase();
const routeOf = e => (e.path || '').replace(/^.*\/api\/?/,'').replace(/^\/+|\/+$/g,'');
const rates = new Map();
const transitions={lobby:['preparing','paused','ended'],preparing:['open','paused','ended'],open:['locked','paused'],locked:['revealed','paused'],revealed:['leaderboard','preparing','round_complete','paused'],leaderboard:['preparing','round_complete','paused'],round_complete:['lobby','ended'],paused:['lobby','preparing','open','locked','revealed','leaderboard','ended'],ended:['lobby']};
async function autoRevealSession(session){if(!session||session.state!=='open'||!session.deadline_at||Date.now()<new Date(session.deadline_at).getTime())return session;const rows=await db(`live_sessions?id=eq.${session.id}&state=eq.open`,{method:'PATCH',body:JSON.stringify({state:'revealed',updated_at:new Date().toISOString(),version:session.version+1})});return rows[0]||{...session,state:'revealed',version:session.version+1}}
function rateLimit(ip, bucket, max=30, windowMs=60000){ const k=`${ip}:${bucket}`; const now=Date.now(); const r=rates.get(k); if(!r||now-r.start>windowMs){rates.set(k,{start:now,count:1});return;} if(++r.count>max) throw Object.assign(new Error('Too many requests. Try again shortly.'),{status:429}); }
function bearer(e){ return String(e.headers?.authorization||e.headers?.Authorization||'').replace(/^Bearer\s+/i,''); }
async function participant(e){ const raw=bearer(e); if(!raw) throw Object.assign(new Error('Join the event first'),{status:401}); const rows=await db(`participants?token_hash=eq.${hash(raw)}&select=*`); if(!rows[0]) throw Object.assign(new Error('Participant session is not valid'),{status:401}); return rows[0]; }
async function audit(admin,ev,action,type,id,beforeData=null,afterData=null){ await db('admin_audit_logs',{method:'POST',body:JSON.stringify({event_id:ev.id,admin_user_id:admin.id,action,entity_type:type,entity_id:id,before_data:beforeData,after_data:afterData})}); }

async function join(e){
  rateLimit(e.headers?.['x-nf-client-connection-ip']||e.headers?.['x-forwarded-for']||'local','join',10,60000);
  const body=JSON.parse(e.body||'{}'); const alias=clean(body.alias);
  if(alias.length<2||alias.length>30||!/[\p{L}\p{N}]/u.test(alias)) return json(422,{error:'Use a 2–30 character alias containing a letter or number.'});
  const ev=await event(); const rawToken=token(32); const recovery=code();
  const rows=await db('participants',{method:'POST',body:JSON.stringify({event_id:ev.id,alias,token_hash:hash(rawToken),recovery_code_hash:hash(recovery),is_rehearsal:Boolean(body.rehearsal)})});
  await db('participant_recovery_codes',{method:'POST',body:JSON.stringify({participant_id:rows[0].id,code_hash:hash(recovery)})});
  return json(201,{participant:{id:rows[0].id,alias},token:rawToken,recoveryCode:recovery});
}
async function recover(e){
  rateLimit(e.headers?.['x-nf-client-connection-ip']||'local','recover',8,300000);
  const recovery=clean(JSON.parse(e.body||'{}').recoveryCode).toUpperCase(); if(!/^[A-Z0-9_-]{3,6}-[A-Z0-9_-]{3,6}$/.test(recovery)) return json(422,{error:'Enter the recovery code in the format shown.'});
  const rows=await db(`participants?recovery_code_hash=eq.${hash(recovery)}&select=*`); if(!rows[0]) return json(404,{error:'Recovery code not found.'});
  const rawToken=token(32); await db(`participants?id=eq.${rows[0].id}`,{method:'PATCH',body:JSON.stringify({token_hash:hash(rawToken),last_seen_at:new Date().toISOString()})});
  return json(200,{participant:{id:rows[0].id,alias:rows[0].alias},token:rawToken});
}
async function liveState(){
  const ev=await event(); const settings=(await db(`event_settings?event_id=eq.${ev.id}&select=active_activity`))[0]; const sessions=await db(`live_sessions?event_id=eq.${ev.id}&select=*&order=updated_at.desc&limit=1`); const s=await autoRevealSession(sessions[0]);
  if(!s) return json(200,{event:ev,state:'lobby',activity:settings?.active_activity||'lens',serverNow:new Date().toISOString()});
  let question=null; if(s.current_question_id){ const q=(await db(`quiz_questions?id=eq.${s.current_question_id}&select=id,round_id,category,question,duration_seconds,image_url,alt_text,explanation,correct_option,is_void`))[0]; if(q){ const options=await db(`question_options?question_id=eq.${q.id}&select=option_index,label&order=option_index`); const round=(await db(`quiz_rounds?id=eq.${q.round_id}&select=day,game_id`))[0]; const game=(await db(`quiz_games?id=eq.${round.game_id}&select=activity,title`))[0]; question={id:q.id,activity:game.activity,title:game.title,day:round.day,category:q.category,question:q.question,durationSeconds:q.duration_seconds,imageUrl:q.image_url,altText:q.alt_text,options:options.map(o=>o.label)}; if(game.activity==='decode'){const d=(await db(`decode_state_rounds?round_id=eq.${q.round_id}&select=clues,state_geo_id,reveal_fact`))[0];question.clueNumber=s.current_clue;question.clue=d?.clues?.[s.current_clue-1]||null;if(['revealed','leaderboard','round_complete'].includes(s.state))question.highlightState=d?.state_geo_id||null;} if(['revealed','leaderboard','round_complete'].includes(s.state)){question.correctOption=q.correct_option;question.explanation=q.explanation;} } }
  const count=(await db(`live_question_state?session_id=eq.${s.id}&select=response_count`))[0]?.response_count||0;
  return json(200,{event:ev,sessionId:s.id,state:s.state,activity:settings?.active_activity||question?.activity||'lens',currentClue:s.current_clue,openedAt:s.opened_at,deadlineAt:s.deadline_at,responseCount:count,question,serverNow:new Date().toISOString()});
}
async function me(e){
  const p=await participant(e); const scores=await db(`score_totals?participant_id=eq.${p.id}&select=activity,day,points,correct_answers,correct_response_ms`); const stamps=await db(`passport_stamps?participant_id=eq.${p.id}&select=category,earned_at`);
  const day1=scores.filter(x=>x.activity==='passport'&&x.day===1).reduce((n,x)=>n+x.points,0),day2=scores.filter(x=>x.activity==='passport'&&x.day===2).reduce((n,x)=>n+x.points,0),decode=scores.filter(x=>x.activity==='decode').reduce((n,x)=>n+x.points,0);
  const peers=await db('score_totals?activity=eq.passport&select=participant_id,points,correct_answers,correct_response_ms,participants!inner(registered_at)'); const agg=new Map(); peers.forEach(x=>{const a=agg.get(x.participant_id)||{totalScore:0,correctAnswers:0,correctResponseMs:0,registeredAt:x.participants.registered_at};a.totalScore+=x.points;a.correctAnswers+=x.correct_answers;a.correctResponseMs+=Number(x.correct_response_ms);agg.set(x.participant_id,a)}); const ranked=[...agg.entries()].sort((a,b)=>(b[1].totalScore-a[1].totalScore)||(b[1].correctAnswers-a[1].correctAnswers)||(a[1].correctResponseMs-b[1].correctResponseMs)||(new Date(a[1].registeredAt)-new Date(b[1].registeredAt)));
  return json(200,{participant:{id:p.id,alias:p.alias},scores:{day1,day2,combined:day1+day2,decode},rank:Math.max(1,ranked.findIndex(([id])=>id===p.id)+1),stamps});
}
async function answer(e){
  rateLimit(e.headers?.['x-nf-client-connection-ip']||'local','answer',45,60000); const p=await participant(e); const b=JSON.parse(e.body||'{}');
  if(!b.sessionId||!b.questionId||!Number.isInteger(b.optionIndex)||b.optionIndex<0||b.optionIndex>3||!/^[0-9a-f-]{36}$/i.test(b.idempotencyKey||'')) return json(422,{error:'Invalid answer submission.'});
  try{const result=await db('rpc/submit_quiz_answer',{method:'POST',body:JSON.stringify({p_token_hash:p.token_hash,p_session_id:b.sessionId,p_question_id:b.questionId,p_option_index:b.optionIndex,p_idempotency_key:b.idempotencyKey})});return json(200,result);}catch(err){if(String(err.message).includes('answer_late'))return json(409,{error:'The answer window has closed.',code:'ANSWER_LATE'});if(String(err.message).includes('question_not_open'))return json(409,{error:'This question is not open.',code:'QUESTION_NOT_OPEN'});throw err;}
}
async function lens(e){
  rateLimit(e.headers?.['x-nf-client-connection-ip']||'local','lens',12,60000); const p=await participant(e); const phrase=clean(JSON.parse(e.body||'{}').phrase); if(!phrase||phrase.length>72||!/[\p{L}\p{N}]/u.test(phrase)) return json(422,{error:'Enter a phrase of 72 characters or fewer.'}); const ev=await event(); const settings=(await db(`event_settings?event_id=eq.${ev.id}&select=lens_submissions_per_participant`))[0]; const current=await db(`lens_submissions?participant_id=eq.${p.id}&event_id=eq.${ev.id}&select=id`); if(current.length>=(settings?.lens_submissions_per_participant||2))return json(409,{error:'You have reached the response limit for this activity.'}); const rows=await db('lens_submissions',{method:'POST',body:JSON.stringify({event_id:ev.id,participant_id:p.id,phrase,normalized_phrase:phrase.toLocaleLowerCase('en-NG'),status:'approved'})}); return json(201,{submission:{id:rows[0].id,phrase,status:'approved'}});
}
async function approvedLens(){ const ev=await event(); const rows=await db(`lens_submissions?event_id=eq.${ev.id}&status=eq.approved&select=id,phrase,normalized_phrase,created_at&order=created_at`); return json(200,{responses:rows}); }
async function leaderboard(e){ const activity=new URL(e.rawUrl||'http://local/api/leaderboard').searchParams.get('activity')==='decode'?'decode':'passport'; const rows=await db(`score_totals?activity=eq.${activity}&select=participant_id,points,correct_answers,correct_response_ms,participants!inner(alias,registered_at)`); const a=new Map(); rows.forEach(x=>{const v=a.get(x.participant_id)||{alias:x.participants.alias,totalScore:0,correctAnswers:0,correctResponseMs:0,registeredAt:x.participants.registered_at};v.totalScore+=x.points;v.correctAnswers+=x.correct_answers;v.correctResponseMs+=Number(x.correct_response_ms);a.set(x.participant_id,v)}); return json(200,{activity,leaders:[...a.values()].sort((x,y)=>(y.totalScore-x.totalScore)||(y.correctAnswers-x.correctAnswers)||(x.correctResponseMs-y.correctResponseMs)||(new Date(x.registeredAt)-new Date(y.registeredAt))).slice(0,10)}); }
async function updateQuestion(e,admin){
  const ev=await event(); const b=JSON.parse(e.body||'{}'); const id=clean(b.id);
  const question=clean(b.question),explanation=clean(b.explanation),source=clean(b.source);
  const options=Array.isArray(b.options)?b.options.map(clean):[]; const correctOption=Number(b.correctOption),durationSeconds=Number(b.durationSeconds);
  const reviewStatus=clean(b.reviewStatus); const statuses=['requires_fact_check','reviewed','approved'];
  if(!/^[0-9a-f-]{36}$/i.test(id))return json(422,{error:'Choose a valid question.'});
  if(!question||question.length>500)return json(422,{error:'The question must be between 1 and 500 characters.'});
  if(options.length!==4||options.some(x=>!x||x.length>180))return json(422,{error:'Enter four answer options of 180 characters or fewer.'});
  if(!Number.isInteger(correctOption)||correctOption<0||correctOption>3)return json(422,{error:'Choose which answer is correct.'});
  if(!Number.isInteger(durationSeconds)||durationSeconds<5||durationSeconds>120)return json(422,{error:'Answer time must be between 5 and 120 seconds.'});
  if(!explanation||explanation.length>1000)return json(422,{error:'Add a short answer explanation.'});
  if(!source||source.length>1000)return json(422,{error:'Add the source used to check this question.'});
  if(!statuses.includes(reviewStatus))return json(422,{error:'Choose a valid review status.'});
  const before=(await db(`quiz_questions?id=eq.${id}&select=*,question_options(*)`))[0];
  if(!before)return json(404,{error:'Question not found.'});
  const live=(await db(`live_sessions?event_id=eq.${ev.id}&current_question_id=eq.${id}&select=state&limit=1`))[0];
  if(live&&['open','locked','revealed','leaderboard'].includes(live.state))return json(409,{error:'This question is being shown now. Finish it or return to the welcome screen before editing.'});
  const after=(await db(`quiz_questions?id=eq.${id}`,{method:'PATCH',body:JSON.stringify({question,correct_option:correctOption,duration_seconds:durationSeconds,explanation,source,review_status:reviewStatus,updated_at:new Date().toISOString()})}))[0];
  await db('question_options?on_conflict=question_id,option_index',{method:'POST',prefer:'resolution=merge-duplicates,return=representation',body:JSON.stringify(options.map((label,option_index)=>({question_id:id,option_index,label})))});
  const saved=(await db(`quiz_questions?id=eq.${id}&select=*,question_options(*)`))[0];
  await audit(admin,ev,'update_question','quiz_question',id,before,saved); return json(200,{question:saved||after});
}
async function adminData(e,admin){
  const ev=await event(); const route=routeOf(e);
  if(route==='admin/lens'){const rows=await db(`lens_submissions?event_id=eq.${ev.id}&select=*,participants(alias)&order=created_at.desc`);return json(200,{responses:rows});}
  if(route==='admin/content'){const rows=await db('quiz_questions?select=*,question_options(*),quiz_rounds!inner(quiz_games!inner(activity))&order=display_order');return json(200,{questions:rows.map(q=>({...q,activity:q.quiz_rounds?.quiz_games?.activity}))});}
  const sessions=await db(`live_sessions?event_id=eq.${ev.id}&select=*&order=updated_at.desc&limit=1`);if(sessions[0])sessions[0]=await autoRevealSession(sessions[0]);const settings=(await db(`event_settings?event_id=eq.${ev.id}&select=*`))[0];
  const rows=await db('quiz_questions?review_status=eq.approved&is_void=eq.false&select=id,category,question,display_order,quiz_rounds!inner(quiz_games!inner(activity))&order=display_order');
  const questions=rows.map(q=>({id:q.id,category:q.category,question:q.question,display_order:q.display_order,activity:q.quiz_rounds?.quiz_games?.activity}));
  const participants=await db(`participants?event_id=eq.${ev.id}&select=id,last_seen_at`);const responseCount=sessions[0]?(await db(`live_question_state?session_id=eq.${sessions[0].id}&select=response_count`))[0]?.response_count||0:0;
  return json(200,{event:ev,settings,session:sessions[0]||null,questions,metrics:{participants:participants.length,responseCount},admin:{displayName:admin.admin.display_name,role:admin.admin.role}});
}
async function adminAction(e,admin){ const ev=await event(); const b=JSON.parse(e.body||'{}'); if(b.kind==='moderate'){const before=(await db(`lens_submissions?id=eq.${b.id}&select=*`))[0]; if(!before)return json(404,{error:'Response not found'}); const allowed=['approved','rejected','hidden','pending']; if(!allowed.includes(b.status))return json(422,{error:'Invalid moderation status'}); const patch={status:b.status,reviewed_by:admin.id,reviewed_at:new Date().toISOString()}; if(typeof b.phrase==='string'){const phrase=clean(b.phrase);if(!phrase||phrase.length>72)return json(422,{error:'Invalid phrase'});patch.phrase=phrase;patch.normalized_phrase=phrase.toLowerCase();} const after=(await db(`lens_submissions?id=eq.${b.id}`,{method:'PATCH',body:JSON.stringify(patch)}))[0];await audit(admin,ev,'moderate','lens_submission',b.id,before,after);return json(200,{response:after});}
  if(b.kind==='set_settings'){
    if(!['lens','passport','decode'].includes(b.activeActivity))return json(422,{error:'Invalid activity.'});
    const before=(await db(`event_settings?event_id=eq.${ev.id}&select=*`))[0];
    const after=(await db(`event_settings?event_id=eq.${ev.id}`,{method:'PATCH',body:JSON.stringify({active_activity:b.activeActivity,rehearsal_mode:Boolean(b.rehearsalMode),updated_at:new Date().toISOString()})}))[0];
    await audit(admin,ev,'set_event_settings','event_settings',ev.id,before,after);return json(200,{settings:after});
  }
  if(b.kind==='clear_data'){
    const rehearsal=b.scope==='rehearsal',phrase=rehearsal?'CLEAR REHEARSAL DATA':'RESET NIAC 2026 PRODUCTION DATA';
    if(b.confirmText!==phrase)return json(422,{error:`Type ${phrase} exactly to confirm.`});
    if(!rehearsal&&admin.admin.role!=='super_admin')return json(403,{error:'Only a super admin can reset production event data.'});
    const people=await db(`participants?event_id=eq.${ev.id}${rehearsal?'&is_rehearsal=eq.true':''}&select=id`);const ids=people.map(x=>x.id);
    await audit(admin,ev,rehearsal?'clear_rehearsal_data':'reset_production_data','event',ev.id,null,{participantCount:ids.length});
    if(ids.length){const filter=`in.(${ids.join(',')})`;await db(`participant_answers?participant_id=${filter}`,{method:'DELETE'});await db(`lens_submissions?participant_id=${filter}`,{method:'DELETE'});await db(`participants?id=${filter}`,{method:'DELETE'});}
    await db(`live_sessions?event_id=eq.${ev.id}`,{method:'PATCH',body:JSON.stringify({state:'lobby',current_question_id:null,current_round_id:null,opened_at:null,deadline_at:null,updated_at:new Date().toISOString()})});
    return json(200,{cleared:ids.length,scope:b.scope});
  }
  const session=await autoRevealSession((await db(`live_sessions?event_id=eq.${ev.id}&select=*&order=updated_at.desc&limit=1`))[0]);
  if(!session)return json(409,{error:'Create a live session in Supabase first.'});
  if(b.kind==='open_question'){
    const q=(await db(`quiz_questions?id=eq.${b.questionId}&review_status=eq.approved&is_void=eq.false&select=id,round_id,duration_seconds,quiz_rounds!inner(quiz_games!inner(activity))`))[0];
    if(!q)return json(422,{error:'Only approved, non-void questions can be opened.'});
    if(session.state==='open')return json(409,{error:'Wait for the current timer to finish before opening another question.'});
    if(session.state==='ended')return json(409,{error:'Return to the welcome screen before opening a question.'});
    const now=new Date(),activity=q.quiz_rounds?.quiz_games?.activity||'passport';
    const after=(await db(`live_sessions?id=eq.${session.id}`,{method:'PATCH',body:JSON.stringify({current_question_id:q.id,current_round_id:q.round_id,current_clue:1,state:'open',opened_at:now.toISOString(),deadline_at:new Date(now.getTime()+(q.duration_seconds||20)*1000).toISOString(),updated_at:now.toISOString(),version:session.version+1})}))[0];
    await db('live_question_state',{method:'POST',prefer:'resolution=merge-duplicates,return=representation',body:JSON.stringify({session_id:session.id,question_id:q.id,response_count:0})});
    await db(`event_settings?event_id=eq.${ev.id}`,{method:'PATCH',body:JSON.stringify({active_activity:activity,updated_at:now.toISOString()})});
    await audit(admin,ev,'open_question','live_session',session.id,session,after);return json(200,{session:after});
  }
  if(b.kind==='select_question'){
    const q=(await db(`quiz_questions?id=eq.${b.questionId}&review_status=eq.approved&is_void=eq.false&select=id,round_id`))[0];
    if(!q)return json(422,{error:'Only approved, non-void questions can be selected.'});
    if(session.state==='open')return json(409,{error:'Lock the current question before selecting another.'});
    const after=(await db(`live_sessions?id=eq.${session.id}`,{method:'PATCH',body:JSON.stringify({current_question_id:q.id,current_round_id:q.round_id,state:'preparing',opened_at:null,deadline_at:null,updated_at:new Date().toISOString(),version:session.version+1})}))[0];
    await audit(admin,ev,'select_question','live_session',session.id,session,after);return json(200,{session:after});
  }
  if(b.kind==='void_question'){
    if(!session.current_question_id)return json(409,{error:'No question is selected.'});
    const before=(await db(`quiz_questions?id=eq.${session.current_question_id}&select=*`))[0];
    await db('rpc/void_quiz_question',{method:'POST',body:JSON.stringify({p_question_id:session.current_question_id})});
    const after=(await db(`quiz_questions?id=eq.${session.current_question_id}&select=*`))[0];
    await audit(admin,ev,'void_question','quiz_question',session.current_question_id,before,after);return json(200,{question:after});
  }
  if(b.kind==='next_clue'){
    if(session.current_clue>=3)return json(409,{error:'The third clue is already showing.'});
    const q=(await db(`quiz_questions?id=eq.${session.current_question_id}&select=duration_seconds`))[0],now=new Date();
    const after=(await db(`live_sessions?id=eq.${session.id}`,{method:'PATCH',body:JSON.stringify({state:'open',current_clue:session.current_clue+1,opened_at:now.toISOString(),deadline_at:new Date(now.getTime()+(q?.duration_seconds||20)*1000).toISOString(),updated_at:now.toISOString(),version:session.version+1})}))[0];
    await db('live_question_state',{method:'POST',prefer:'resolution=merge-duplicates,return=representation',body:JSON.stringify({session_id:session.id,question_id:session.current_question_id,response_count:0})});
    await audit(admin,ev,'next_clue','live_session',session.id,session,after);return json(200,{session:after});
  }
  const allowed=['lobby','preparing','open','locked','revealed','leaderboard','round_complete','paused','ended'];
  if(!allowed.includes(b.state))return json(422,{error:'Invalid state'});
  if(!transitions[session.state]?.includes(b.state))return json(409,{error:`Cannot move directly from ${session.state} to ${b.state}.`});
  const patch={state:b.state,updated_at:new Date().toISOString(),version:session.version+1};
  if(b.state==='paused')patch.resume_state=session.state;
  if(b.state==='open'){
    if(!session.current_question_id)return json(409,{error:'Select an approved question first.'});
    const q=(await db(`quiz_questions?id=eq.${session.current_question_id}&select=duration_seconds`))[0];
    patch.opened_at=new Date().toISOString();patch.deadline_at=new Date(Date.now()+(Number(b.durationSeconds)||q?.duration_seconds||20)*1000).toISOString();
    await db('live_question_state',{method:'POST',prefer:'resolution=merge-duplicates,return=representation',body:JSON.stringify({session_id:session.id,question_id:session.current_question_id,response_count:0})});
  }
  const after=(await db(`live_sessions?id=eq.${session.id}`,{method:'PATCH',body:JSON.stringify(patch)}))[0];
  await audit(admin,ev,'set_live_state','live_session',session.id,session,after);return json(200,{session:after}); }

export async function handler(e){
  try{ if(e.httpMethod==='OPTIONS')return {statusCode:204,headers:{allow:'GET,POST,PATCH,OPTIONS'}}; const route=routeOf(e),method=e.httpMethod;
    if(method==='POST'&&route==='participants')return await join(e); if(method==='POST'&&route==='recover')return await recover(e); if(method==='GET'&&route==='state')return await liveState(); if(method==='GET'&&route==='me')return await me(e); if(method==='POST'&&route==='answers')return await answer(e); if(method==='POST'&&route==='lens')return await lens(e); if(method==='GET'&&route==='lens/approved')return await approvedLens(); if(method==='GET'&&route==='leaderboard')return await leaderboard(e);
    if(route.startsWith('admin/')){const admin=await verifyAdmin(e.headers?.authorization);if(method==='GET')return await adminData(e,admin);if(method==='POST')return await adminAction(e,admin);if(method==='PATCH'&&route==='admin/question')return await updateQuestion(e,admin);}
    return json(404,{error:'Not found'});
  }catch(err){console.error(err);return json(err.status||500,{error:err.status&&err.status<500?err.message:'The event service could not complete that request.',code:err.status===503?'NOT_CONFIGURED':'REQUEST_FAILED'});}
}
