import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { formatLog, globalMetrics, redactSensitive } from '../lib/telemetry.mjs';
import { createStateEnvelope, sanitizePublicQuestion } from '../lib/state-envelope.mjs';
import { signParticipantCredential } from '../lib/credentials.mjs';
import { generateSnapshots } from '../lib/snapshot-scoring.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const port=Number(process.env.PORT||4173);
const storePath=join(root,'.local-data','niac.json');
const questionFile=JSON.parse(await readFile(join(root,'content','questions.json'),'utf8'));
const decodeFile=JSON.parse(await readFile(join(root,'content','decode-rounds.json'),'utf8'));
const passport=questionFile.questions.map((q,i)=>({...q,id:`passport-${q.day}-${q.order}`,activity:'passport',title:'Naija Passport Challenge',durationSeconds:q.durationSeconds||20}));
const decode=decodeFile.rounds.map((r,i)=>({id:`decode-${i+1}`,day:i<3?1:2,order:i+1,category:r.zone,question:'Which Nigerian state do these clues describe?',options:r.options,correctOption:r.correctOption,explanation:r.revealFact,activity:'decode',title:'Decode the State',durationSeconds:30,clues:r.clues,clueMedia:r.clueMedia,highlightState:r.geoId}));
const questions=[...passport,...decode];
const fresh=()=>({settings:{active_activity:'lens',rehearsal_mode:true,rosterFrozen:false,capacityMode:'auto',maxActivePlayers:1500},participants:[],lens:[],answers:[],audit:[],questionOverrides:{},session:{id:'local-session',state:'lobby',currentQuestionId:null,currentClue:1,openedAt:null,deadlineAt:null,responseCount:0,version:1},leaderboardSnapshots:{},participantSnapshots:{}});
let data;try{data=JSON.parse(await readFile(storePath,'utf8'))}catch{data=fresh()}
data.questionOverrides||={};data.leaderboardSnapshots||={};data.participantSnapshots||={};questions.forEach(q=>Object.assign(q,data.questionOverrides[q.id]||{}));
const persist=async()=>{await mkdir(join(root,'.local-data'),{recursive:true});await writeFile(storePath,JSON.stringify(data,null,2))};

const sseClients = new Set();
function getPublicStateEnvelope(){
  const q=questions.find(x=>x.id===data.session.currentQuestionId);
  const envelope=createStateEnvelope({
    event:{name:'Nigeria Independence Anniversary Celebration 2026'},
    eventId:'niac-2026',
    sessionId:data.session.id,
    version:data.session.version,
    state:data.session.state,
    activity:data.settings.active_activity,
    currentClue:data.session.currentClue,
    openedAt:data.session.openedAt,
    deadlineAt:data.session.deadlineAt,
    responseCount:data.session.responseCount,
    serverNow:new Date().toISOString()
  },safeQuestion());
  return envelope;
}

function broadcastState(){
  const envelope=getPublicStateEnvelope();
  const payload=`id: ${envelope.version}\nevent: state\ndata: ${JSON.stringify(envelope)}\n\n`;
  for(const client of sseClients){
    try{client.write(payload)}catch{sseClients.delete(client)}
  }
  globalMetrics.setActiveConnections(sseClients.size);
}

function triggerSnapshotScoring(){
  try{
    const snapshots=generateSnapshots({
      sessionId:data.session.id,
      snapshotVersion:data.session.version,
      participants:data.participants,
      answers:data.answers,
      questions
    });
    data.leaderboardSnapshots={
      passport:snapshots.leaderboards.passport,
      decode:snapshots.leaderboards.decode
    };
    data.participantSnapshots=Object.fromEntries(snapshots.participantSnapshotsMap);
  }catch(err){
    console.error(formatLog('error','snapshot_scoring_error',{error:err.message}));
  }
}

async function autoReveal(){if(data.session.state==='open'&&data.session.deadlineAt&&Date.now()>=new Date(data.session.deadlineAt).getTime()){data.session.state='revealed';data.session.version++;triggerSnapshotScoring();data.audit.push({at:new Date().toISOString(),action:'auto_reveal'});console.log(formatLog('info','reveal_job',{sessionId:data.session.id,questionId:data.session.currentQuestionId,version:data.session.version}));await persist();broadcastState();}}
const routes={'/':'index.html','/activities':'activities.html','/lens':'lens.html','/lens/live':'lens-live.html','/play':'play.html','/passport':'passport.html','/display':'display.html','/admin':'admin.html','/admin/content':'admin-content.html'};
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};
const send=(res,status,body,type='application/json; charset=utf-8',headers={})=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store',...headers});res.end(type.startsWith('application/json')?JSON.stringify(body):body)};
const body=async req=>{let value='';for await(const chunk of req){value+=chunk;if(value.length>100000)throw new Error('Body too large')}return value?JSON.parse(value):{}};
const clean=v=>String(v??'').trim().replace(/\s+/g,' ').replace(/[<>\u0000-\u001f\u007f]/g,'');
const bearer=req=>String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
const participant=req=>data.participants.find(p=>p.token===bearer(req));
const admin=req=>bearer(req)==='local-admin';
const safeQuestion=()=>{const q=questions.find(x=>x.id===data.session.currentQuestionId);if(!q)return null;const out={...q};if(q.activity==='decode'){out.clueNumber=data.session.currentClue;out.clue=q.clues[data.session.currentClue-1];if(q.clueMedia&&q.clueMedia[data.session.currentClue-1]){out.media=q.clueMedia[data.session.currentClue-1];out.imageUrl=out.media.src;out.altText=out.media.alt;out.fallback=out.media.fallback;}out.cluesSoFar=q.clues.slice(0,data.session.currentClue);out.clueMediaSoFar=(q.clueMedia||[]).slice(0,data.session.currentClue);if(['revealed','leaderboard','round_complete'].includes(data.session.state)){out.highlightState=q.highlightState;}}return sanitizePublicQuestion(out,data.session.state)};
const totals=p=>{const mine=data.answers.filter(a=>a.participantId===p.id);const sum=(activity,day)=>mine.filter(a=>a.activity===activity&&(!day||a.day===day)&&!a.voided).reduce((n,a)=>n+a.points,0);return{day1:sum('passport',1),day2:sum('passport',2),combined:sum('passport'),decode:sum('decode')}};
const ranked=activity=>data.participants.map(p=>{const mine=data.answers.filter(a=>a.participantId===p.id&&a.activity===activity&&!a.voided);return{alias:p.alias,totalScore:mine.reduce((n,a)=>n+a.points,0),correctAnswers:mine.filter(a=>a.correct).length,correctResponseMs:mine.filter(a=>a.correct).reduce((n,a)=>n+a.responseMs,0),registeredAt:p.registeredAt}}).sort((a,b)=>(b.totalScore-a.totalScore)||(b.correctAnswers-a.correctAnswers)||(a.correctResponseMs-b.correctResponseMs)||(new Date(a.registeredAt)-new Date(b.registeredAt)));
const leaders=activity=>ranked(activity).slice(0,10);

async function api(req,res,url){
  const path=url.pathname.slice(4)||'/';
  const requestId=req.headers['x-request-id']||crypto.randomUUID();
  const reqStart=Date.now();
  const resSend=(status,body,type='application/json; charset=utf-8')=>send(res,status,body,type,{'x-request-id':requestId});
  await autoReveal();

  if(path==='/dev/admin'&&req.method==='POST'){if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return resSend(403,{error:'Local access only'});return resSend(200,{token:'local-admin'})}
  if(path==='/participants'&&req.method==='POST'){
    const b=await body(req),alias=clean(b.alias);
    if(alias.length<2||alias.length>30)return resSend(422,{error:'Use a 2–30 character alias.'});
    const maxActive=Number(data.settings.maxActivePlayers||1500);
    const activeCount=data.participants.filter(p=>!p.isSpectator).length;
    const isSpectator=Boolean(b.spectator||data.settings.rosterFrozen||(data.settings.capacityMode==='red')||(activeCount>=maxActive));
    const p={id:crypto.randomUUID(),alias,isSpectator,token:crypto.randomBytes(24).toString('base64url'),recoveryCode:`${crypto.randomBytes(2).toString('hex')}-${crypto.randomBytes(2).toString('hex')}`.toUpperCase(),registeredAt:new Date().toISOString()};
    data.participants.push(p);await persist();
    const credential=signParticipantCredential({participantId:p.id,eventId:'niac-2026',isRehearsal:Boolean(b.rehearsal),isSpectator});
    console.log(formatLog('info','join',{requestId,participantId:p.id,alias:p.alias,isSpectator,rehearsal:Boolean(b.rehearsal),durationMs:Date.now()-reqStart}));
    return resSend(201,{participant:{id:p.id,alias:p.alias,isSpectator},token:p.token,credential,recoveryCode:p.recoveryCode});
  }
  if(path==='/recover'&&req.method==='POST'){
    const b=await body(req),p=data.participants.find(x=>x.recoveryCode===clean(b.recoveryCode).toUpperCase());
    if(!p)return resSend(404,{error:'Recovery code not found.'});
    p.token=crypto.randomBytes(24).toString('base64url');await persist();
    const credential=signParticipantCredential({participantId:p.id,eventId:'niac-2026',isSpectator:Boolean(p.isSpectator)});
    console.log(formatLog('info','recover',{requestId,participantId:p.id,durationMs:Date.now()-reqStart}));
    return resSend(200,{participant:{id:p.id,alias:p.alias,isSpectator:Boolean(p.isSpectator)},token:p.token,credential});
  }
  if(path==='/bootstrap'&&req.method==='GET'){
    const envelope=getPublicStateEnvelope();
    return resSend(200,{
      state:envelope,
      serverNow:new Date().toISOString(),
      transport:{
        gatewaySse:'/api/live/stream',
        fallbackPollIntervalMs:4000,
        reconnectJitterMaxMs:1500
      }
    });
  }
  if(path==='/live/stream'&&req.method==='GET'){
    res.writeHead(200,{
      'content-type':'text/event-stream; charset=utf-8',
      'cache-control':'no-cache, no-transform',
      'connection':'keep-alive',
      'x-request-id':requestId
    });
    const envelope=getPublicStateEnvelope();
    res.write(`id: ${envelope.version}\nevent: state\ndata: ${JSON.stringify(envelope)}\n\n`);
    sseClients.add(res);
    globalMetrics.setActiveConnections(sseClients.size);
    const heartbeat=setInterval(()=>{try{res.write(': keepalive\n\n')}catch{clearInterval(heartbeat)}},15000);
    heartbeat.unref?.();
    req.on('close',()=>{clearInterval(heartbeat);sseClients.delete(res);globalMetrics.setActiveConnections(sseClients.size);});
    return;
  }
  if(path==='/state'&&req.method==='GET'){
    console.log(formatLog('debug','state_delivery',{requestId,state:data.session.state,durationMs:Date.now()-reqStart}));
    return resSend(200,getPublicStateEnvelope());
  }
  if(path==='/lens/approved'&&req.method==='GET')return resSend(200,{responses:data.lens.filter(x=>x.status==='approved').map(x=>({id:x.id,phrase:x.phrase,normalized_phrase:x.phrase.toLowerCase(),created_at:x.createdAt}))});
  if(path==='/leaderboard'&&req.method==='GET'){
    const activity=url.searchParams.get('activity')==='decode'?'decode':'passport';
    console.log(formatLog('info','leaderboard_read',{requestId,activity,durationMs:Date.now()-reqStart}));
    const cached=data.leaderboardSnapshots?.[activity];
    if(cached&&cached.leaders){
      return resSend(200,{activity,leaders:cached.leaders});
    }
    return resSend(200,{activity,leaders:leaders(activity)});
  }
  const p=participant(req);
  if(path==='/me'&&req.method==='GET'){
    if(!p)return resSend(401,{error:'Join the event first'});
    const snap=data.participantSnapshots?.[p.id];
    if(snap){
      console.log(formatLog('info','score_read',{requestId,participantId:p.id,rank:snap.rank,durationMs:Date.now()-reqStart,snapshot:true}));
      return resSend(200,{participant:{id:p.id,alias:p.alias},scores:snap.scores,rank:snap.rank,stamps:snap.stamps});
    }
    const score=totals(p),rank=Math.max(1,ranked('passport').findIndex(x=>x.alias===p.alias)+1);
    const cats=new Set(data.answers.filter(a=>a.participantId===p.id&&a.activity==='passport'&&a.correct).map(a=>a.category));
    console.log(formatLog('info','score_read',{requestId,participantId:p.id,rank,durationMs:Date.now()-reqStart}));
    return resSend(200,{participant:{id:p.id,alias:p.alias},scores:score,rank,stamps:[...cats].map(category=>({category}))});
  }
  if(path==='/lens'&&req.method==='POST'){
    if(!p)return resSend(401,{error:'Join the event first'});
    const b=await body(req),phrase=clean(b.phrase);
    if(!phrase||phrase.length>72)return resSend(422,{error:'Enter a phrase of 72 characters or fewer.'});
    const item={id:crypto.randomUUID(),participantId:p.id,phrase,status:'approved',createdAt:new Date().toISOString()};
    data.lens.push(item);await persist();
    console.log(formatLog('info','lens_submit',{requestId,participantId:p.id,submissionId:item.id,durationMs:Date.now()-reqStart}));
    return resSend(201,{submission:{id:item.id,phrase,status:item.status}});
  }
  if(path==='/answers'&&req.method==='POST'){
    const ackStart=Date.now();
    if(!p){globalMetrics.recordError('UNAUTHORIZED');return resSend(401,{error:'Join the event first'})}
    const b=await body(req);
    if(p.isSpectator){
      const duration=Date.now()-ackStart;
      globalMetrics.recordAckLatency(duration);
      console.log(formatLog('info','spectator_answer',{requestId,participantId:p.id,questionId:b.questionId,durationMs:duration}));
      return resSend(200,{accepted:true,duplicate:false,spectator:true,message:'Answer recorded in spectator mode'});
    }
    const existing=data.answers.find(a=>a.participantId===p.id&&(a.questionId===b.questionId||a.idempotencyKey===b.idempotencyKey));
    if(existing){
      const duration=Date.now()-ackStart;globalMetrics.recordAckLatency(duration);
      console.log(formatLog('info','answer_duplicate',{requestId,participantId:p.id,questionId:b.questionId,answerId:existing.id,durationMs:duration}));
      return resSend(200,{accepted:true,duplicate:true,answerId:existing.id});
    }
    if(data.session.state!=='open'||data.session.currentQuestionId!==b.questionId){
      globalMetrics.recordError('QUESTION_NOT_OPEN');
      console.log(formatLog('warn','answer_rejected',{requestId,participantId:p.id,reason:'QUESTION_NOT_OPEN',durationMs:Date.now()-ackStart}));
      return resSend(409,{error:'This question is not open.',code:'QUESTION_NOT_OPEN'});
    }
    if(Date.now()>new Date(data.session.deadlineAt)){
      globalMetrics.recordError('ANSWER_LATE');
      console.log(formatLog('warn','answer_late',{requestId,participantId:p.id,questionId:b.questionId,durationMs:Date.now()-ackStart}));
      return resSend(409,{error:'The answer window has closed.',code:'ANSWER_LATE'});
    }
    const q=questions.find(x=>x.id===b.questionId),correct=b.optionIndex===q.correctOption,points=correct?1000:0;
    const a={id:crypto.randomUUID(),participantId:p.id,questionId:q.id,idempotencyKey:b.idempotencyKey,optionIndex:b.optionIndex,activity:q.activity,day:q.day,category:q.category,correct,points,responseMs:Date.now()-new Date(data.session.openedAt)};
    data.answers.push(a);data.session.responseCount++;await persist();
    const ackDuration=Date.now()-ackStart;globalMetrics.recordAckLatency(ackDuration);
    console.log(formatLog('info','answer_received',{requestId,participantId:p.id,questionId:q.id,answerId:a.id,correct,durationMs:ackDuration}));
    return resSend(200,{accepted:true,duplicate:false,answerId:a.id});
  }
  if(path.startsWith('/admin/')){
    if(!admin(req))return resSend(401,{error:'Admin sign-in required'});
    if(path==='/admin/capacity'&&req.method==='GET')return resSend(200,globalMetrics.getSnapshot());
    if(path==='/admin/status'&&req.method==='GET'){const activeCount=data.participants.filter(p=>!p.isSpectator).length;const spectatorCount=data.participants.filter(p=>p.isSpectator).length;return resSend(200,{event:{name:'NIAC Live'},settings:data.settings,session:data.session,questions:questions.filter(q=>(q.reviewStatus||q.review_status||'requires_fact_check')==='approved'||data.settings.rehearsal_mode).map(q=>({id:q.id,category:q.category,question:q.question,display_order:q.order,activity:q.activity})),metrics:{participants:data.participants.length,activeParticipants:activeCount,spectators:spectatorCount,activeCount,spectatorCount,rosterFrozen:Boolean(data.settings.rosterFrozen),responseCount:data.session.responseCount},capacity:globalMetrics.getSnapshot(),admin:{displayName:'Local event operator',role:'super_admin'}})}
    if(path==='/admin/lens'&&req.method==='GET')return resSend(200,{responses:data.lens.map(x=>({...x,created_at:x.createdAt,participants:{alias:data.participants.find(p=>p.id===x.participantId)?.alias||'Legacy'}})).reverse()});
    if(path==='/admin/content'&&req.method==='GET')return resSend(200,{questions:questions.map(q=>({...q,correct_option:q.correctOption,duration_seconds:q.durationSeconds,review_status:q.reviewStatus||q.review_status||'requires_fact_check',question_options:q.options.map((label,option_index)=>({option_index,label}))}))});
    if(path==='/admin/question'&&req.method==='PATCH'){const b=await body(req),q=questions.find(x=>x.id===b.id),options=Array.isArray(b.options)?b.options.map(clean):[];if(!q)return resSend(404,{error:'Question not found.'});if(data.session.currentQuestionId===q.id&&['open','locked','revealed','leaderboard'].includes(data.session.state))return resSend(409,{error:'This question is being shown now. Finish it or return to the welcome screen before editing.'});const question=clean(b.question),explanation=clean(b.explanation),source=clean(b.source),correctOption=Number(b.correctOption),durationSeconds=Number(b.durationSeconds),reviewStatus=clean(b.reviewStatus);if(!question||question.length>500)return resSend(422,{error:'The question must be between 1 and 500 characters.'});if(options.length!==4||options.some(x=>!x||x.length>180))return resSend(422,{error:'Enter four answer options of 180 characters or fewer.'});if(!Number.isInteger(correctOption)||correctOption<0||correctOption>3)return resSend(422,{error:'Choose which answer is correct.'});if(!Number.isInteger(durationSeconds)||durationSeconds<5||durationSeconds>120)return resSend(422,{error:'Answer time must be between 5 and 120 seconds.'});if(!explanation||explanation.length>1000)return resSend(422,{error:'Add a short answer explanation.'});if(!source||source.length>1000)return resSend(422,{error:'Add the source used to check this question.'});if(!['requires_fact_check','reviewed','approved'].includes(reviewStatus))return resSend(422,{error:'Choose a valid review status.'});const media=b.media&&typeof b.media==='object'&&b.media.src?{src:clean(b.media.src),timing:['question','reveal'].includes(b.media.timing)?b.media.timing:'question',alt:clean(b.media.alt),caption:clean(b.media.caption),author:clean(b.media.author),license:clean(b.media.license)}:null;const fallback=b.fallback?clean(b.fallback):null;Object.assign(q,{question,options,correctOption,durationSeconds,explanation,source,reviewStatus,media,fallback,image_fallback:fallback});data.questionOverrides[q.id]={question,options,correctOption,durationSeconds,explanation,source,reviewStatus,media,fallback,image_fallback:fallback};data.audit.push({at:new Date().toISOString(),action:'update_question',questionId:q.id});await persist();return resSend(200,{question:{...q,correct_option:q.correctOption,duration_seconds:q.durationSeconds,review_status:q.reviewStatus,media:q.media,fallback:q.fallback,image_fallback:q.fallback,question_options:q.options.map((label,option_index)=>({option_index,label}))}})}
    if(path==='/admin/action'&&req.method==='POST'){const b=await body(req);if(b.kind==='toggle_roster_freeze'){data.settings.rosterFrozen=!data.settings.rosterFrozen;await persist();broadcastState();return resSend(200,{settings:data.settings})}else if(b.kind==='set_capacity_mode'){data.settings.capacityMode=b.mode||'auto';await persist();broadcastState();return resSend(200,{settings:data.settings})}else if(b.kind==='moderate'){const x=data.lens.find(v=>v.id===b.id);if(!x)return resSend(404,{error:'Response not found'});x.status=b.status;if(b.phrase)x.phrase=clean(b.phrase)}else if(b.kind==='set_settings'){data.settings={...data.settings,active_activity:b.activeActivity,rehearsal_mode:Boolean(b.rehearsalMode)}}else if(b.kind==='open_question'){const q=questions.find(x=>x.id===b.questionId);if(!q)return resSend(422,{error:'Choose a valid question.'});if(data.session.state==='open')return resSend(409,{error:'Wait for the current timer to finish before opening another question.'});if(data.session.state==='ended')return resSend(409,{error:'Return to the welcome screen before opening a question.'});const now=new Date();data.settings.active_activity=q.activity;if(data.settings.autoFreezeOnOpen)data.settings.rosterFrozen=true;const clueNum=q.activity==='decode'?(data.session.currentQuestionId===q.id?data.session.currentClue:3):1;data.session={...data.session,state:'open',currentQuestionId:q.id,currentClue:clueNum,openedAt:now.toISOString(),deadlineAt:new Date(now.getTime()+(q.durationSeconds||30)*1000).toISOString(),responseCount:0,version:data.session.version+1}}else if(b.kind==='select_question'){data.session={...data.session,state:'preparing',currentQuestionId:b.questionId,currentClue:1,openedAt:null,deadlineAt:null,responseCount:0,version:data.session.version+1}}else if(b.kind==='next_clue'){if(data.session.currentClue>=3)return resSend(409,{error:'The third clue is already showing.'});data.session.currentClue++;data.session.version++}else if(b.kind==='void_question'){data.answers.filter(a=>a.questionId===data.session.currentQuestionId).forEach(a=>{a.voided=true;a.points=0})}else if(b.kind==='clear_data'){if(!['CLEAR REHEARSAL DATA','RESET NIAC 2026 PRODUCTION DATA'].includes(b.confirmText))return resSend(422,{error:'Confirmation did not match.'});const count=data.participants.length,questionOverrides=data.questionOverrides;data=fresh();data.questionOverrides=questionOverrides;await persist();return resSend(200,{cleared:count,scope:b.scope})}else{const allowed={lobby:['preparing','paused','ended'],preparing:['open','paused','ended'],open:['locked','paused'],locked:['revealed','paused'],revealed:['leaderboard','preparing','round_complete','paused'],leaderboard:['preparing','round_complete','paused'],round_complete:['lobby','ended'],paused:['lobby','preparing','open','locked','revealed','leaderboard','ended'],ended:['lobby']};if(!allowed[data.session.state]?.includes(b.state))return resSend(409,{error:`Cannot move directly from ${data.session.state} to ${b.state}.`});data.session.state=b.state;if(b.state==='open'){const q=questions.find(x=>x.id===data.session.currentQuestionId);data.session.openedAt=new Date().toISOString();data.session.deadlineAt=new Date(Date.now()+(q?.durationSeconds||20)*1000).toISOString();data.session.responseCount=0}if(b.state==='revealed'||b.state==='leaderboard'){data.session.version++;triggerSnapshotScoring()}}data.audit.push({at:new Date().toISOString(),action:b.kind||b.state});await persist();broadcastState();return resSend(200,{session:data.session})}
  }
  return resSend(404,{error:'Not found'});
}

const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://local');if(url.pathname.startsWith('/api'))return await api(req,res,url);if(['/content','/supabase','/scripts','/tests','/load'].some(x=>url.pathname.startsWith(x)))return send(res,404,'Not found','text/plain');const relative=routes[url.pathname]||url.pathname.slice(1)||'index.html';const safe=normalize(relative).replace(/^(\.\.(\/|\\|$))+/,'');const file=join(root,safe);const value=await readFile(file);send(res,200,value,mime[extname(file)]||'application/octet-stream')}catch(err){send(res,err.code==='ENOENT'?404:500,err.code==='ENOENT'?'Not found':'Local server error','text/plain')}});
server.listen(port,'127.0.0.1',()=>console.log(`NIAC Live local event server: http://127.0.0.1:${port}`));
