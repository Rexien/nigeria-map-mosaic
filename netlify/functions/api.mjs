import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { db, event, verifyAdmin } from './_db.mjs';
import { formatLog, getCapacityConfig } from '../../lib/telemetry.mjs';
import { computeStateChecksum, createStateEnvelope } from '../../lib/state-envelope.mjs';
import { signParticipantCredential } from '../../lib/credentials.mjs';
import { generateSnapshots } from '../../lib/snapshot-scoring.mjs';
import { createReadCache, createRateLimiter } from './_traffic.mjs';

const requestContext=new AsyncLocalStorage();
const json = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-request-id':requestContext.getStore()?.requestId||'',...headers }, body: JSON.stringify(body) });
const clean = value => String(value ?? '').trim().replace(/\s+/g,' ').replace(/[<>\u0000-\u001f\u007f]/g,'');
const hash = value => crypto.createHash('sha256').update(`${process.env.PARTICIPANT_TOKEN_PEPPER || ''}:${value}`).digest('hex');
const token = bytes => crypto.randomBytes(bytes).toString('base64url');
const code = () => `${token(3).slice(0,4)}-${token(3).slice(0,4)}`.toUpperCase();
const routeOf = e => (e.path || '').replace(/^.*\/api\/?/,'').replace(/^\/+|\/+$/g,'');
const publicReads=createReadCache(),rankingReads=createReadCache();
const rateLimit=createRateLimiter();
const clientIp=e=>e.headers?.['x-nf-client-connection-ip']||e.headers?.['x-forwarded-for']||'local';
const gatewayBase=()=>String(process.env.PUBLIC_GATEWAY_URL||'').replace(/\/$/,'');
const transitions={lobby:['preparing','paused','ended'],preparing:['open','paused','ended'],open:['locked','paused'],locked:['revealed','paused'],revealed:['leaderboard','preparing','round_complete','paused','lobby'],leaderboard:['preparing','round_complete','paused','lobby'],round_complete:['lobby','ended'],paused:['lobby','preparing','open','locked','revealed','leaderboard','ended'],ended:['lobby']};
async function dbAll(path){const rows=[];for(let offset=0;;offset+=1000){const page=await db(`${path}${path.includes('?')?'&':'?'}limit=1000&offset=${offset}`);rows.push(...page);if(page.length<1000)return rows}}
async function computeAndPersistSnapshots(sessionId, version){
    const session=(await db(`live_sessions?id=eq.${sessionId}&select=event_id`))[0];
    if(!session)throw new Error('Snapshot session not found');
    const participants = await dbAll(`participants?event_id=eq.${session.event_id}&select=id,alias,registered_at,is_spectator`);
    const raw = await dbAll(`gateway_answers?session_id=eq.${sessionId}&select=participant_id,question_id,option_index,clue_number,response_ms`);
    const legacy = await dbAll(`participant_answers?session_id=eq.${sessionId}&select=participant_id,question_id,option_index,clue_number,response_ms,is_correct,points`);
    const questionRows=await dbAll('quiz_questions?select=id,correct_option,is_void,category,quiz_rounds(day,quiz_games(activity))');
    const questions=questionRows.map(q=>({id:q.id,correct_option:q.correct_option,is_void:q.is_void,category:q.category,day:q.quiz_rounds?.day||1,activity:q.quiz_rounds?.quiz_games?.activity||'passport'}));
    const seen=new Set(legacy.map(a=>`${a.participant_id}:${a.question_id}`));
    const answers=[...legacy,...raw.filter(a=>!seen.has(`${a.participant_id}:${a.question_id}`))];
    const snapshots = generateSnapshots({
      sessionId,
      snapshotVersion: version,
      participants: participants || [],
      answers,
      questions
    });
    await db('leaderboard_snapshots?on_conflict=session_id,activity,snapshot_version', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates',
      body: JSON.stringify(snapshots.leaderboardSnapshots.map(s => ({
        session_id: s.sessionId,
        activity: s.activity,
        snapshot_version: s.snapshotVersion,
        leaders: s.leaders
      })))
    });
    for(let start=0;start<snapshots.participantScoreSnapshots.length;start+=500){
      await db('participant_score_snapshots?on_conflict=session_id,participant_id,snapshot_version', {
        method:'POST',prefer:'resolution=merge-duplicates',
        body: JSON.stringify(snapshots.participantScoreSnapshots.slice(start,start+500).map(s => ({
          session_id: s.sessionId,
          participant_id: s.participantId,
          snapshot_version: s.snapshotVersion,
          rank: s.rank,
          scores: s.scores,
          stamps: s.stamps
        })))
      });
    }
}
async function gatewayCall(path,envelope){
  if(!gatewayBase())return null;
  const response=await fetch(`${gatewayBase()}/gateway/${path}`,{method:'POST',headers:{Authorization:`Bearer ${process.env.GATEWAY_ADMIN_SECRET||''}`,'Content-Type':'application/json'},body:JSON.stringify(envelope)});
  if(!response.ok)throw Object.assign(new Error(`Live gateway ${path} failed (${response.status})`),{status:503});
  return response.json();
}
async function gatewayHealth(){
  const limits=getCapacityConfig();
  const unavailable=(configured,statusReason)=>({
    status:configured?'red':'amber',statusReason,activeConnections:0,queueDepth:0,p95AckMs:0,errorRatePercent:0,
    limits:{testPlayers:limits.testPlayers,maxActivePlayers:limits.maxActivePlayers,queueDepthLimit:limits.queueDepthLimit}
  });
  if(!gatewayBase())return unavailable(false,'Gateway is not configured; clients will use direct polling.');
  try{
    const response=await fetch(`${gatewayBase()}/gateway/health`,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(2500)});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const health=await response.json();
    return health.capacity||unavailable(true,'Gateway health metrics are unavailable.');
  }catch(error){
    console.error(formatLog('error','gateway_health_failed',{error:error.message}));
    return unavailable(true,'Gateway is unreachable; participant clients are falling back to direct polling.');
  }
}
async function pushGatewayState(){
  if(!gatewayBase())return;
  publicReads.clear();
  const response=await buildLiveState(true);
  await gatewayCall('broadcast',JSON.parse(response.body));
}
async function finalizeReveal(session){
  const lockedState=JSON.parse((await buildLiveState(true)).body);
  await gatewayCall('lock-and-drain',lockedState);
  const revealVersion=Number(session.version)+1;
  await computeAndPersistSnapshots(session.id,revealVersion);
  const rows=await db(`live_sessions?id=eq.${session.id}&state=eq.locked`,{method:'PATCH',body:JSON.stringify({state:'revealed',updated_at:new Date().toISOString(),version:revealVersion})});
  const revealed=rows[0]||{...session,state:'revealed',version:revealVersion};
  publicReads.clear();rankingReads.clear();
  await pushGatewayState();
  return revealed;
}
async function autoRevealSession(session){
  if(!session||!session.deadline_at||Date.now()<new Date(session.deadline_at).getTime())return session;
  if(session.state==='open'){
    const rows=await db(`live_sessions?id=eq.${session.id}&state=eq.open`,{method:'PATCH',body:JSON.stringify({state:'locked',updated_at:new Date().toISOString(),version:Number(session.version)+1})});
    session=rows[0]||(await db(`live_sessions?id=eq.${session.id}&select=*`))[0];
  }
  return session?.state==='locked'?finalizeReveal(session):session;
}
function bearer(e){ return String(e.headers?.authorization||e.headers?.Authorization||'').replace(/^Bearer\s+/i,''); }
async function participant(e){ const raw=bearer(e); if(!raw) throw Object.assign(new Error('Join the event first'),{status:401}); const rows=await db(`participants?token_hash=eq.${hash(raw)}&select=*`); if(!rows[0]) throw Object.assign(new Error('Participant session is not valid'),{status:401}); return rows[0]; }
async function audit(admin,ev,action,type,id,beforeData=null,afterData=null){ await db('admin_audit_logs',{method:'POST',body:JSON.stringify({event_id:ev.id,admin_user_id:admin.id,action,entity_type:type,entity_id:id,before_data:beforeData,after_data:afterData})}); }

async function join(e){
  rateLimit(clientIp(e),'join',1500,60000);
  const body=JSON.parse(e.body||'{}'); const alias=clean(body.alias);
  if(alias.length<2||alias.length>30||!/[\p{L}\p{N}]/u.test(alias)) return json(422,{error:'Use a 2–30 character alias containing a letter or number.'});
  const ev=await event(); const rawToken=token(32); const recovery=code();
  const settings=(await db(`event_settings?event_id=eq.${ev.id}&select=*`))[0];
  const isSpectator=Boolean(body.spectator||settings?.roster_frozen);
  const rows=await db('participants',{method:'POST',body:JSON.stringify({event_id:ev.id,alias,token_hash:hash(rawToken),recovery_code_hash:hash(recovery),is_rehearsal:Boolean(body.rehearsal),is_spectator:isSpectator})});
  await db('participant_recovery_codes',{method:'POST',body:JSON.stringify({participant_id:rows[0].id,code_hash:hash(recovery)})});
  const credential = signParticipantCredential({ participantId: rows[0].id, eventId: ev.id, isRehearsal: Boolean(body.rehearsal), isSpectator });
  return json(201,{participant:{id:rows[0].id,alias,isSpectator},token:rawToken,credential,recoveryCode:recovery});
}
async function recover(e){
  const recovery=clean(JSON.parse(e.body||'{}').recoveryCode).toUpperCase();
  rateLimit(clientIp(e),'recover-network',1500,300000);rateLimit(hash(recovery),'recover-code',8,300000);
  if(!/^[A-Z0-9_-]{3,6}-[A-Z0-9_-]{3,6}$/.test(recovery)) return json(422,{error:'Enter the recovery code in the format shown.'});
  const rows=await db(`participants?recovery_code_hash=eq.${hash(recovery)}&select=*`); if(!rows[0]) return json(404,{error:'Recovery code not found.'});
  const rawToken=token(32); await db(`participants?id=eq.${rows[0].id}`,{method:'PATCH',body:JSON.stringify({token_hash:hash(rawToken),last_seen_at:new Date().toISOString()})});
  const isSpectator=Boolean(rows[0].is_spectator);
  const credential = signParticipantCredential({ participantId: rows[0].id, eventId: rows[0].event_id, isSpectator });
  return json(200,{participant:{id:rows[0].id,alias:rows[0].alias,isSpectator},token:rawToken,credential});
}
async function buildLiveState(skipAuto=false){
  const ev=await event(); const settings=(await db(`event_settings?event_id=eq.${ev.id}&select=active_activity,screen_mode`))[0]; const sessions=await db(`live_sessions?event_id=eq.${ev.id}&select=*&order=updated_at.desc&limit=1`); const s=skipAuto?sessions[0]:await autoRevealSession(sessions[0]);
  if(!s){const envelope=createStateEnvelope({event:ev,eventId:ev.id,state:'lobby',activity:settings?.active_activity||'lens',screenMode:settings?.screen_mode||'welcome',serverNow:new Date().toISOString()});return json(200,envelope)}
  let question=null; if(s.current_question_id&&(s.state==='preparing'||['open','locked','revealed','leaderboard','round_complete'].includes(s.state))){ const q=(await db(`quiz_questions?id=eq.${s.current_question_id}&select=*`))[0]; if(q){ const options=await db(`question_options?question_id=eq.${q.id}&select=option_index,label&order=option_index`); const round=(await db(`quiz_rounds?id=eq.${q.round_id}&select=day,game_id`))[0]; const game=(await db(`quiz_games?id=eq.${round.game_id}&select=activity,title`))[0]; question={id:q.id,activity:game.activity,title:game.title,day:round.day,category:q.category,question:q.question,durationSeconds:q.duration_seconds,imageUrl:q.image_url,altText:q.alt_text,media:q.media||null,fallback:q.image_fallback||null,options:options.map(o=>o.label)}; if(game.activity==='decode'){const d=(await db(`decode_state_rounds?round_id=eq.${q.round_id}&select=clues,clue_media,state_geo_id,reveal_fact`))[0];question.clueNumber=s.current_clue;question.clue=d?.clues?.[s.current_clue-1]||null;if(d?.clue_media&&d.clue_media[s.current_clue-1]){question.media=d.clue_media[s.current_clue-1];question.imageUrl=question.media.src;question.altText=question.media.alt;question.fallback=question.media.fallback;}question.cluesSoFar=(d?.clues||[]).slice(0,s.current_clue);question.clueMediaSoFar=(d?.clue_media||[]).slice(0,s.current_clue);if(['revealed','leaderboard','round_complete'].includes(s.state))question.highlightState=d?.state_geo_id||null;} if(['revealed','leaderboard','round_complete'].includes(s.state)){question.correctOption=q.correct_option;question.explanation=q.explanation;} } }
  const envelope = createStateEnvelope({
    event: ev,
    eventId: ev.id,
    sessionId: s.id,
    version: s.version,
    state: s.state,
    activity: settings?.active_activity || question?.activity || 'lens',
    screenMode: settings?.screen_mode || 'welcome',
    currentClue: s.current_clue,
    openedAt: s.opened_at,
    deadlineAt: s.deadline_at,
    responseCount: 0,
    serverNow: new Date().toISOString()
  }, question);
  return json(200, envelope);
}
async function liveState(){
  const response=await publicReads.get('state',500,()=>buildLiveState(false),result=>{const s=JSON.parse(result.body);return s.state==='open'?new Date(s.deadlineAt).getTime():Infinity});
  const state={...JSON.parse(response.body),serverNow:new Date().toISOString()};
  const {checksum:discardedChecksum,...payload}=state;
  return json(200,{...payload,checksum:computeStateChecksum(payload)});
}
async function bootstrap(){
  const s = await liveState();
  const body = JSON.parse(s.body);
  return json(200, {
    state: body,
    serverNow: new Date().toISOString(),
    transport: {
      gatewaySse: gatewayBase()?`${gatewayBase()}/gateway/stream`:null,
      gatewayAnswer: gatewayBase()?`${gatewayBase()}/gateway/answers`:null,
      fallbackPollIntervalMs: 4000,
      reconnectJitterMaxMs: 1500
    }
  });
}
async function me(e){
  const p=await participant(e);
  const ev=await event();
  try{
    const session=(await db(`live_sessions?event_id=eq.${ev.id}&select=id&order=updated_at.desc&limit=1`))[0];
    const snap=session?(await db(`participant_score_snapshots?participant_id=eq.${p.id}&session_id=eq.${session.id}&select=rank,scores,stamps&order=snapshot_version.desc&limit=1`))[0]:null;
    if(snap&&snap.scores){
      return json(200,{participant:{id:p.id,alias:p.alias},isSpectator:Boolean(p.is_spectator),scores:snap.scores,rank:snap.rank,stamps:snap.stamps});
    }
  }catch{}
  const scores=await db(`score_totals?participant_id=eq.${p.id}&select=activity,day,points,correct_answers,correct_response_ms`); const stamps=await db(`passport_stamps?participant_id=eq.${p.id}&select=category,earned_at`);
  const day1=scores.filter(x=>x.activity==='passport'&&x.day===1).reduce((n,x)=>n+x.points,0),day2=scores.filter(x=>x.activity==='passport'&&x.day===2).reduce((n,x)=>n+x.points,0),decode=scores.filter(x=>x.activity==='decode').reduce((n,x)=>n+x.points,0);
  const peers=await db(`score_totals?activity=eq.passport&select=participant_id,points,correct_answers,correct_response_ms,participants!inner(registered_at,event_id)&participants.event_id=eq.${ev.id}`); const agg=new Map(); peers.forEach(x=>{const a=agg.get(x.participant_id)||{totalScore:0,correctAnswers:0,correctResponseMs:0,registeredAt:x.participants.registered_at};a.totalScore+=x.points;a.correctAnswers+=x.correct_answers;a.correctResponseMs+=Number(x.correct_response_ms);agg.set(x.participant_id,a)}); const ranked=[...agg.entries()].sort((a,b)=>(b[1].totalScore-a[1].totalScore)||(b[1].correctAnswers-a[1].correctAnswers)||(a[1].correctResponseMs-b[1].correctResponseMs)||(new Date(a[1].registeredAt)-new Date(b[1].registeredAt)));
  return json(200,{participant:{id:p.id,alias:p.alias},isSpectator:Boolean(p.is_spectator),scores:{day1,day2,combined:day1+day2,decode},rank:p.is_spectator?null:Math.max(1,ranked.findIndex(([id])=>id===p.id)+1),stamps});
}
async function answer(e){
  const p=await participant(e);rateLimit(p.id,'answer',45,60000); const b=JSON.parse(e.body||'{}');
  if(!b.sessionId||!b.questionId||!Number.isInteger(b.optionIndex)||b.optionIndex<0||b.optionIndex>3||!/^[0-9a-f-]{36}$/i.test(b.idempotencyKey||'')) return json(422,{error:'Invalid answer submission.'});
  if(p.is_spectator){
    return json(200,{accepted:true,duplicate:false,spectator:true,message:'Answer recorded in spectator mode'});
  }
  try{const result=await db('rpc/submit_raw_quiz_answer',{method:'POST',body:JSON.stringify({p_token_hash:p.token_hash,p_session_id:b.sessionId,p_question_id:b.questionId,p_option_index:b.optionIndex,p_idempotency_key:b.idempotencyKey})});return json(200,result);}catch(err){if(String(err.message).includes('answer_late'))return json(409,{error:'The answer window has closed.',code:'ANSWER_LATE'});if(String(err.message).includes('question_not_open'))return json(409,{error:'This question is not open.',code:'QUESTION_NOT_OPEN'});throw err;}
}
async function lens(e){
  const p=await participant(e);rateLimit(p.id,'lens',12,60000); const phrase=clean(JSON.parse(e.body||'{}').phrase); if(!phrase||phrase.length>72||!/[\p{L}\p{N}]/u.test(phrase)) return json(422,{error:'Enter a phrase of 72 characters or fewer.'}); const ev=await event(); const settings=(await db(`event_settings?event_id=eq.${ev.id}&select=lens_submissions_per_participant`))[0]; const current=await db(`lens_submissions?participant_id=eq.${p.id}&event_id=eq.${ev.id}&select=id`); if(current.length>=(settings?.lens_submissions_per_participant||2))return json(409,{error:'You have reached the response limit for this activity.'}); const rows=await db('lens_submissions',{method:'POST',body:JSON.stringify({event_id:ev.id,participant_id:p.id,phrase,normalized_phrase:phrase.toLocaleLowerCase('en-NG'),status:'approved'})}); return json(201,{submission:{id:rows[0].id,phrase,status:'approved'}});
}
async function approvedLens(){ const ev=await event(); const rows=await db(`lens_submissions?event_id=eq.${ev.id}&status=eq.approved&select=id,phrase,normalized_phrase,created_at&order=created_at`); return json(200,{responses:rows}); }
async function leaderboard(e){
  const activity=new URL(e.rawUrl||'http://local/api/leaderboard').searchParams.get('activity')==='decode'?'decode':'passport';
  const ev=await event();
  try{
    const session=(await db(`live_sessions?event_id=eq.${ev.id}&select=id&order=updated_at.desc&limit=1`))[0];
    const snap=session?(await db(`leaderboard_snapshots?session_id=eq.${session.id}&activity=eq.${activity}&select=leaders&order=snapshot_version.desc&limit=1`))[0]:null;
    if(snap&&snap.leaders){
      return json(200,{activity,leaders:snap.leaders});
    }
  }catch{}
  const rows=await db(`score_totals?activity=eq.${activity}&select=participant_id,points,correct_answers,correct_response_ms,participants!inner(alias,registered_at,event_id)&participants.event_id=eq.${ev.id}`); const a=new Map(); rows.forEach(x=>{const v=a.get(x.participant_id)||{alias:x.participants.alias,totalScore:0,correctAnswers:0,correctResponseMs:0,registeredAt:x.participants.registered_at};v.totalScore+=x.points;v.correctAnswers+=x.correct_answers;v.correctResponseMs+=Number(x.correct_response_ms);a.set(x.participant_id,v)}); return json(200,{activity,leaders:[...a.values()].sort((x,y)=>(y.totalScore-x.totalScore)||(y.correctAnswers-x.correctAnswers)||(x.correctResponseMs-y.correctResponseMs)||(new Date(x.registeredAt)-new Date(y.registeredAt))).slice(0,10)});
}
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
  const media=b.media&&typeof b.media==='object'&&b.media.src?{src:clean(b.media.src),timing:['question','reveal'].includes(b.media.timing)?b.media.timing:'question',alt:clean(b.media.alt),caption:clean(b.media.caption),author:clean(b.media.author),license:clean(b.media.license)}:null;
  const fallback=b.fallback?clean(b.fallback):null;
  const after=(await db(`quiz_questions?id=eq.${id}`,{method:'PATCH',body:JSON.stringify({question,correct_option:correctOption,duration_seconds:durationSeconds,explanation,source,review_status:reviewStatus,media,image_fallback:fallback,updated_at:new Date().toISOString()})}))[0];
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
  const participants=await db(`participants?event_id=eq.${ev.id}&select=id,is_spectator,last_seen_at`);
  const activeParticipants=(participants||[]).filter(p=>!p.is_spectator).length;
  const spectators=(participants||[]).filter(p=>p.is_spectator).length;
  let responseCount=0;
  if(sessions[0]?.current_question_id){
    try{responseCount=Number(await db('rpc/count_quiz_answers',{method:'POST',body:JSON.stringify({p_session_id:sessions[0].id,p_question_id:sessions[0].current_question_id})}))||0}
    catch{responseCount=(await db(`live_question_state?session_id=eq.${sessions[0].id}&select=response_count`))[0]?.response_count||0}
  }
  const capacity=await gatewayHealth();
  return json(200,{event:ev,settings,session:sessions[0]||null,questions,capacity,metrics:{participants:participants.length,activeParticipants,spectators,activeCount:activeParticipants,spectatorCount:spectators,rosterFrozen:Boolean(settings?.roster_frozen),responseCount},admin:{displayName:admin.admin.display_name,role:admin.admin.role}});
}
async function adminAction(e,admin){ const ev=await event(); const b=JSON.parse(e.body||'{}');
  if(b.kind==='toggle_roster_freeze'){
    const before=(await db(`event_settings?event_id=eq.${ev.id}&select=*`))[0];
    const isFrozen=!before?.roster_frozen;
    const after=(await db(`event_settings?event_id=eq.${ev.id}`,{method:'PATCH',body:JSON.stringify({roster_frozen:isFrozen,updated_at:new Date().toISOString()})}))[0];
    await audit(admin,ev,'toggle_roster_freeze','event_settings',ev.id,before,after);
    return json(200,{settings:after});
  }
  if(b.kind==='moderate'){const before=(await db(`lens_submissions?id=eq.${b.id}&select=*`))[0]; if(!before)return json(404,{error:'Response not found'}); const allowed=['approved','rejected','hidden','pending']; if(!allowed.includes(b.status))return json(422,{error:'Invalid moderation status'}); const patch={status:b.status,reviewed_by:admin.id,reviewed_at:new Date().toISOString()}; if(typeof b.phrase==='string'){const phrase=clean(b.phrase);if(!phrase||phrase.length>72)return json(422,{error:'Invalid phrase'});patch.phrase=phrase;patch.normalized_phrase=phrase.toLowerCase();} const after=(await db(`lens_submissions?id=eq.${b.id}`,{method:'PATCH',body:JSON.stringify(patch)}))[0];await audit(admin,ev,'moderate','lens_submission',b.id,before,after);return json(200,{response:after});}
  if(b.kind==='set_settings'){
    if(!['lens','passport','decode'].includes(b.activeActivity))return json(422,{error:'Invalid activity.'});
    const current=(await db(`live_sessions?event_id=eq.${ev.id}&select=*&order=updated_at.desc&limit=1`))[0];
    if(current?.state==='open')return json(409,{error:'Wait for the current question to close before changing activities.'});
    const before=(await db(`event_settings?event_id=eq.${ev.id}&select=*`))[0];
    const after=(await db(`event_settings?event_id=eq.${ev.id}`,{method:'PATCH',body:JSON.stringify({active_activity:b.activeActivity,screen_mode:'activity',rehearsal_mode:Boolean(b.rehearsalMode),updated_at:new Date().toISOString()})}))[0];
    if(current){const changed=before.active_activity!==b.activeActivity;await db(`live_sessions?id=eq.${current.id}`,{method:'PATCH',body:JSON.stringify({...(changed?{state:'lobby',current_question_id:null,current_round_id:null,opened_at:null,deadline_at:null}:{}),version:current.version+1,updated_at:new Date().toISOString()})});}
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
  if(b.kind==='show_welcome'){
    if(session.state==='open')return json(409,{error:'Wait for the current question to close before showing Welcome.'});
    await db(`event_settings?event_id=eq.${ev.id}`,{method:'PATCH',body:JSON.stringify({screen_mode:'welcome',updated_at:new Date().toISOString()})});
    const after=(await db(`live_sessions?id=eq.${session.id}`,{method:'PATCH',body:JSON.stringify({state:'lobby',current_question_id:null,current_round_id:null,opened_at:null,deadline_at:null,updated_at:new Date().toISOString(),version:session.version+1})}))[0];
    await audit(admin,ev,'show_welcome','live_session',session.id,session,after);
    return json(200,{session:after});
  }
  if(b.kind==='open_question'){
    const q=(await db(`quiz_questions?id=eq.${b.questionId}&review_status=eq.approved&is_void=eq.false&select=id,round_id,duration_seconds,quiz_rounds!inner(quiz_games!inner(activity))`))[0];
    if(!q)return json(422,{error:'Only approved, non-void questions can be opened.'});
    if(session.state==='open')return json(409,{error:'Wait for the current timer to finish before opening another question.'});
    if(session.state==='ended')return json(409,{error:'Return to the welcome screen before opening a question.'});
    const now=new Date(),activity=q.quiz_rounds?.quiz_games?.activity||'passport';
    const after=(await db(`live_sessions?id=eq.${session.id}`,{method:'PATCH',body:JSON.stringify({current_question_id:q.id,current_round_id:q.round_id,current_clue:1,state:'open',opened_at:now.toISOString(),deadline_at:new Date(now.getTime()+(q.duration_seconds||20)*1000).toISOString(),updated_at:now.toISOString(),version:session.version+1})}))[0];
    await db('live_question_state',{method:'POST',prefer:'resolution=merge-duplicates,return=representation',body:JSON.stringify({session_id:session.id,question_id:q.id,response_count:0})});
    await db(`event_settings?event_id=eq.${ev.id}`,{method:'PATCH',body:JSON.stringify({active_activity:activity,screen_mode:'activity',updated_at:now.toISOString()})});
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
    const after=(await db(`live_sessions?id=eq.${session.id}`,{method:'PATCH',body:JSON.stringify({current_clue:session.current_clue+1,updated_at:new Date().toISOString(),version:session.version+1})}))[0];
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
  if(b.state==='revealed'){
    const lockedState=JSON.parse((await buildLiveState(true)).body);
    await gatewayCall('lock-and-drain',lockedState);
    await computeAndPersistSnapshots(session.id,patch.version);
  }
  const after=(await db(`live_sessions?id=eq.${session.id}`,{method:'PATCH',body:JSON.stringify(patch)}))[0];
  await audit(admin,ev,'set_live_state','live_session',session.id,session,after);return json(200,{session:after}); }

export async function handler(e){
  const requestId=e.headers?.['x-request-id']||e.headers?.['X-Request-Id']||crypto.randomUUID();
  return requestContext.run({requestId},async()=>{
    const startAt=Date.now();
    try{ if(e.httpMethod==='OPTIONS')return {statusCode:204,headers:{allow:'GET,POST,PATCH,OPTIONS','x-request-id':requestId}}; const route=routeOf(e),method=e.httpMethod;
      let res,mutated=false;
      if(method==='POST'&&route==='participants') res=await join(e);
      else if(method==='POST'&&route==='recover') res=await recover(e);
      else if(method==='GET'&&route==='bootstrap') res=await bootstrap();
      else if(method==='GET'&&route==='state') res=await liveState();
      else if(method==='GET'&&route==='me') res=await me(e);
      else if(method==='POST'&&route==='answers') res=await answer(e);
      else if(method==='POST'&&route==='lens') res=await lens(e);
      else if(method==='GET'&&route==='lens/approved') res=await approvedLens();
      else if(method==='GET'&&route==='leaderboard') res=await leaderboard(e);
      else if(route.startsWith('admin/')){const admin=await verifyAdmin(e.headers?.authorization);if(method==='GET')res=await adminData(e,admin);else if(method==='POST'){res=await adminAction(e,admin);mutated=true}else if(method==='PATCH'&&route==='admin/question'){res=await updateQuestion(e,admin);mutated=true}}
      if(mutated){publicReads.clear();rankingReads.clear();try{await pushGatewayState()}catch(error){console.error(formatLog('error','gateway_broadcast_failed',{requestId,error:error.message}))}}
      if(res){console.log(formatLog('info','api_request',{requestId,method,route,statusCode:res.statusCode,durationMs:Date.now()-startAt}));return res}
      return json(404,{error:'Not found'});
    }catch(err){
      console.error(formatLog('error','api_error',{requestId,error:err.message,status:err.status||500,durationMs:Date.now()-startAt}));
      return json(err.status||500,{error:err.status&&err.status<500?err.message:'The event service could not complete that request.',code:err.status===503?'GATEWAY_NOT_READY':'REQUEST_FAILED'});
    }
  });
}
