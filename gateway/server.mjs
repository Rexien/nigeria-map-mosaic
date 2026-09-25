// NIAC Live Gateway Server (Phase 2 & Phase 3 Acceleration Layer)
// Designed for Oracle VM deployment with Caddy TLS reverse proxy.
// Distributes state changes once over SSE / WebSocket and ingests answers into SQLite WAL queue.

import http from 'node:http';
import crypto from 'node:crypto';
import { formatLog, globalMetrics } from '../lib/telemetry.mjs';
import { createStateEnvelope, verifyStateEnvelope } from '../lib/state-envelope.mjs';
import { verifyParticipantCredential } from '../lib/credentials.mjs';
import { SQLiteAnswerQueue } from './lib/sqlite-queue.mjs';
import { BatchFlusher } from './lib/batch-flusher.mjs';

const PORT = Number(process.env.GATEWAY_PORT || process.env.PORT || 4180);
const ADMIN_SECRET = process.env.GATEWAY_ADMIN_SECRET || (process.env.NODE_ENV==='production'?'':'dev-gateway-secret');

let cachedEnvelope = createStateEnvelope({
  eventId: 'niac-2026',
  sessionId: 'initial-session',
  version: 1,
  state: 'lobby',
  serverNow: new Date().toISOString()
});

export const sseClients = new Set();
export const wsClients = new Set();
let authoritySyncObserver = null;

export function resetClients() {
  sseClients.clear();
  wsClients.clear();
}

export function getCachedState() {
  return cachedEnvelope;
}

export function setCachedEnvelope(envelope) {
  cachedEnvelope = envelope;
}

export function broadcastState(envelope) {
  cachedEnvelope = envelope;
  authoritySyncObserver?.observe(envelope);
  const payload = `id: ${envelope.version}\nevent: state\ndata: ${JSON.stringify(envelope)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
      client.destroy?.();
    }
  }

  // Also fan out to WebSocket clients if connected
  for (const ws of wsClients) {
    try {
      if (ws.readyState === 1) { // OPEN
        ws.send(JSON.stringify({ event: 'state', data: envelope }));
      }
    } catch {
      wsClients.delete(ws);
    }
  }

  const totalConnected = sseClients.size + wsClients.size;
  globalMetrics.setActiveConnections(totalConnected);
  return totalConnected;
}

function comparableEnvelope(envelope){
  if(!envelope)return '';
  const {checksum,serverNow,responseCount,...stable}=envelope;
  return JSON.stringify(stable);
}

const ACTIVE_RECONCILE_STATES = new Set(['preparing', 'open', 'locked']);

function deadlineIdentity(envelope) {
  if (!envelope?.sessionId || !envelope?.question?.id || !Number.isFinite(Number(envelope?.version))) return null;
  return `${envelope.sessionId}:${envelope.question.id}:${Number(envelope.version)}`;
}

function scoreIdentity(envelope) {
  return envelope?.state === 'revealed' ? deadlineIdentity(envelope) : null;
}

export async function refreshAuthorityState(baseUrl=process.env.AUTHORITY_BASE_URL||process.env.PUBLIC_EVENT_URL){
  const base=String(baseUrl||'').replace(/\/$/,'');
  if(!base)return null;
  const response=await fetch(`${base}/api/state`,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(4000)});
  if(!response.ok)throw new Error(`Authority state fetch failed (${response.status})`);
  const envelope=await response.json();
  if(!verifyStateEnvelope(envelope))throw new Error('Authority returned an invalid state checksum');
  if(Number(envelope.version)<Number(cachedEnvelope.version))return cachedEnvelope;
  if(Number(envelope.version)>Number(cachedEnvelope.version)||comparableEnvelope(envelope)!==comparableEnvelope(cachedEnvelope))broadcastState(envelope);
  return envelope;
}

export async function notifyAuthorityDeadline(envelope,options={}){
  const base=String(options.baseUrl||process.env.AUTHORITY_BASE_URL||process.env.PUBLIC_EVENT_URL||'').replace(/\/$/,'');
  if(!base)throw new Error('Authority base URL is not configured');
  const secret=String(options.secret||process.env.GATEWAY_ADMIN_SECRET||'');
  if(!secret)throw new Error('Gateway admin secret is required for deadline callbacks');
  if(!deadlineIdentity(envelope))throw new Error('Cannot schedule a deadline callback without session, question, and version');
  const response=await fetch(`${base}/api/internal/deadline`,{
    method:'POST',
    headers:{Accept:'application/json',Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},
    body:JSON.stringify({
      sessionId:envelope.sessionId,
      questionId:envelope.question.id,
      version:Number(envelope.version)
    }),
    signal:AbortSignal.timeout(Number(options.timeoutMs||5000))
  });
  let body={};
  try{body=await response.json()}catch{}
  if(!response.ok){
    const error=new Error(body?.error||`Authority deadline callback failed (${response.status})`);
    error.status=response.status;
    error.code=body?.code||null;
    error.retryAfterMs=Number(body?.retryAfterMs||0);
    throw error;
  }
  return body;
}

export async function notifyAuthorityScore(envelope, options = {}) {
  const base = String(options.baseUrl || process.env.AUTHORITY_BASE_URL || process.env.PUBLIC_EVENT_URL || '').replace(/\/$/, '');
  const secret = String(options.secret || process.env.GATEWAY_ADMIN_SECRET || '');
  if (!base || !secret || !scoreIdentity(envelope)) throw new Error('Cannot score without authority URL, secret, and revealed state');
  const response = await fetch(`${base}/api/internal/score`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: envelope.sessionId, questionId: envelope.question.id, version: Number(envelope.version) }),
    signal: AbortSignal.timeout(Number(options.timeoutMs || 60000))
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body?.error || `Authority score callback failed (${response.status})`);
    error.status = response.status;
    error.code = body?.code || null;
    throw error;
  }
  return body;
}

export function startAuthoritySync(options={}){
  const baseUrl=options.baseUrl||process.env.AUTHORITY_BASE_URL||process.env.PUBLIC_EVENT_URL;
  if(!baseUrl)return null;

  const secret=options.secret||process.env.GATEWAY_ADMIN_SECRET;
  const reconcileMs=Math.max(10,Number(options.reconcileMs??process.env.AUTHORITY_RECONCILE_MS??60000));
  const retryBaseMs=Math.max(10,Number(options.retryBaseMs??process.env.DEADLINE_RETRY_BASE_MS??1000));
  const retryMaxMs=Math.max(retryBaseMs,Number(options.retryMaxMs??process.env.DEADLINE_RETRY_MAX_MS??10000));
  const maxDeadlineAttempts=Math.max(1,Number(options.maxDeadlineAttempts??process.env.DEADLINE_RETRY_ATTEMPTS??8));

  let deadlineTimer=null;
  let reconcileTimer=null;
  const scoreJobs = new Map();
  const completedScores = new Set();
  let stopped=false;
  let reconciling=false;

  const clearDeadline=()=>{if(deadlineTimer){clearTimeout(deadlineTimer);deadlineTimer=null}};
  const clearReconcile=()=>{if(reconcileTimer){clearTimeout(reconcileTimer);reconcileTimer=null}};

  const isStillCurrent=envelope=>{
    const expected=deadlineIdentity(envelope);
    return Boolean(expected&&cachedEnvelope?.state==='open'&&deadlineIdentity(cachedEnvelope)===expected);
  };

  const scheduleReconcile=(envelope=cachedEnvelope)=>{
    clearReconcile();
    const hasLiveClients=sseClients.size+wsClients.size>0;
    if(stopped||(!ACTIVE_RECONCILE_STATES.has(envelope?.state)&&!hasLiveClients))return;
    reconcileTimer=setTimeout(()=>{reconcileTimer=null;void reconcileNow()},reconcileMs);
    reconcileTimer.unref?.();
  };

  const fireDeadline=async(envelope,attempt=0)=>{
    if(stopped||!isStillCurrent(envelope))return;
    try{
      await notifyAuthorityDeadline(envelope,{baseUrl,secret,timeoutMs:options.deadlineTimeoutMs});
      if(stopped)return;
      await refreshAuthorityState(baseUrl);
    }catch(error){
      if(stopped||!isStillCurrent(envelope))return;

      if(error.code==='DEADLINE_NOT_REACHED'&&Number(error.retryAfterMs)>0){
        const delay=Math.max(10,Number(error.retryAfterMs)+25);
        deadlineTimer=setTimeout(()=>{deadlineTimer=null;void fireDeadline(envelope,attempt)},delay);
        deadlineTimer.unref?.();
        return;
      }

      if(error.code==='STALE_DEADLINE'){
        try{await refreshAuthorityState(baseUrl)}
        catch(refreshError){
          globalMetrics.recordError('AUTHORITY_SYNC');
          console.error(formatLog('error','authority_sync_failed',{error:refreshError.message}));
          scheduleReconcile(cachedEnvelope);
        }
        return;
      }

      globalMetrics.recordError('AUTHORITY_DEADLINE');
      console.error(formatLog('error','authority_deadline_failed',{attempt:attempt+1,error:error.message}));
      if(attempt+1>=maxDeadlineAttempts){
        scheduleReconcile(cachedEnvelope);
        return;
      }
      const backoff=Math.min(retryBaseMs*(2**attempt),retryMaxMs);
      deadlineTimer=setTimeout(()=>{deadlineTimer=null;void fireDeadline(envelope,attempt+1)},backoff);
      deadlineTimer.unref?.();
    }
  };

  const scheduleDeadline=envelope=>{
    clearDeadline();
    if(stopped||envelope?.state!=='open'||!deadlineIdentity(envelope))return;
    const deadlineMs=new Date(envelope.deadlineAt||'').getTime();
    if(!Number.isFinite(deadlineMs))return;
    const delay=Math.max(0,deadlineMs-Date.now());
    deadlineTimer=setTimeout(()=>{deadlineTimer=null;void fireDeadline(envelope,0)},delay);
    deadlineTimer.unref?.();
  };

  const scheduleScore = envelope => {
    const identity = scoreIdentity(envelope);
    if (stopped || !identity || completedScores.has(identity) || scoreJobs.has(identity)) return;
    const job = { timer: null };
    scoreJobs.set(identity, job);
    const run = async attempt => {
      if (stopped) return;
      try {
        await notifyAuthorityScore(envelope, { baseUrl, secret, timeoutMs: options.scoreTimeoutMs });
        completedScores.add(identity);
        scoreJobs.delete(identity);
      } catch (error) {
        if (stopped) return;
        if (error.code === 'STALE_SCORE') {
          scoreJobs.delete(identity);
          return;
        }
        globalMetrics.recordError('AUTHORITY_SCORE');
        console.error(formatLog('error', 'authority_score_failed', { attempt: attempt + 1, version: envelope.version, error: error.message }));
        const delay = Math.min(retryBaseMs * (2 ** Math.min(attempt, 4)), retryMaxMs);
        job.timer = setTimeout(() => { job.timer = null; void run(attempt + 1); }, delay);
        job.timer.unref?.();
      }
    };
    job.timer = setTimeout(() => { job.timer = null; void run(0); }, 0);
    job.timer.unref?.();
  };

  const observe=envelope=>{
    if(stopped)return;
    scheduleDeadline(envelope);
    scheduleScore(envelope);
    scheduleReconcile(envelope);
  };

  const reconcileNow=async()=>{
    if(stopped||reconciling)return;
    reconciling=true;
    try{
      const envelope=await refreshAuthorityState(baseUrl);
      if(envelope)observe(envelope);
    }catch(error){
      globalMetrics.recordError('AUTHORITY_SYNC');
      console.error(formatLog('error','authority_sync_failed',{error:error.message}));
    }finally{
      reconciling=false;
      if(!stopped)scheduleReconcile(cachedEnvelope);
    }
  };

  let lastClientReconcileAt=0;
  const controller={
    observe,
    reconcileNow,
    clientActivity(){
      if(stopped)return;
      scheduleReconcile(cachedEnvelope);
      const now=Date.now();
      const minGapMs=Math.max(1000,Number(options.clientReconcileMinGapMs??10000));
      if(now-lastClientReconcileAt<minGapMs)return;
      lastClientReconcileAt=now;
      void reconcileNow();
    },
    stop(){
      stopped=true;
      clearDeadline();
      clearReconcile();
      for (const job of scoreJobs.values()) if (job.timer) clearTimeout(job.timer);
      scoreJobs.clear();
      if(authoritySyncObserver===controller)authoritySyncObserver=null;
    }
  };

  authoritySyncObserver=controller;
  void reconcileNow();
  return controller;
}

export function createSupabaseSink(url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY,options={}){
  if(!url||!key)return null;
  const timeoutMs=Number(options.timeoutMs ?? process.env.SUPABASE_FLUSH_TIMEOUT_MS ?? 4000);
  if(!Number.isInteger(timeoutMs)||timeoutMs<1)throw new Error('Invalid Supabase flush timeout');
  return async items=>{
    const response=await fetch(`${url}/rest/v1/gateway_answers?on_conflict=participant_id,question_id`,{
      method:'POST',
      signal:AbortSignal.timeout(timeoutMs),
      headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'resolution=ignore-duplicates,return=minimal'},
      body:JSON.stringify(items.map(item=>({
        id:item.answer_id,participant_id:item.participant_id,session_id:item.session_id,question_id:item.question_id,
        option_index:item.option_index,clue_number:item.clue_number,response_ms:item.response_ms,
        idempotency_key:item.idempotency_key,received_at:item.received_at
      })))
    });
    if(!response.ok)throw new Error(`Supabase answer flush failed (${response.status}): ${await response.text()}`);
  };
}

async function readJson(req,maxBytes=32768){
  let body='',size=0;
  for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw Object.assign(new Error('Request body too large'),{status:413});body+=chunk;}
  try{return JSON.parse(body||'{}')}catch{throw Object.assign(new Error('Invalid JSON'),{status:400})}
}

export function createGatewayServer(customQueue = null, options = {}) {
  const queue = customQueue || new SQLiteAnswerQueue(options.dbPath || null);
  const sink=options.sink===undefined?createSupabaseSink():options.sink;
  const flusher=options.flusher||(sink?new BatchFlusher(queue,{sink,flushIntervalMs:150,batchSize:100}):null);
  if(flusher&&options.startFlusher!==false)flusher.start();
  const allowedOrigin=options.allowedOrigin||process.env.PUBLIC_APP_ORIGIN||(process.env.NODE_ENV==='production'?'':'*');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();

    const origin=req.headers.origin;
    const allowedOrigins = allowedOrigin ? allowedOrigin.split(',').map(s => s.trim()).filter(Boolean) : [];
    const isOriginAllowed = allowedOrigin === '*' || (origin && allowedOrigins.includes(origin));
    const cors=isOriginAllowed?{'access-control-allow-origin':allowedOrigin==='*'?'*':origin,'vary':'Origin'}:{};
    const sendJson = (status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-request-id': requestId,
        ...cors
      });
      res.end(JSON.stringify(body));
    };

    if(req.method==='OPTIONS'){
      res.writeHead(204,{...cors,'access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'authorization,content-type,x-request-id','access-control-max-age':'86400'});return res.end();
    }

    // Health endpoint for Caddy / uptime monitors
    if (path === '/gateway/health' && req.method === 'GET') {
      globalMetrics.setQueueDepth(queue.getQueueDepth());
      return sendJson(200, {
        status: flusher ? 'healthy' : 'degraded',
        uptimeSeconds: Math.round(process.uptime()),
        connectedClients: sseClients.size + wsClients.size,
        currentVersion: cachedEnvelope.version,
        currentState: cachedEnvelope.state,
        queueDepth: queue.getQueueDepth(),
        totalQueued: queue.getTotalCount(),
        durableSinkConfigured:Boolean(flusher),
        capacity:globalMetrics.getSnapshot()
      });
    }

    // Cached state endpoint
    if (path === '/gateway/state' && req.method === 'GET') {
      return sendJson(200, cachedEnvelope);
    }

    // SSE stream for broadcast
    if (path === '/gateway/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-request-id': requestId,
        ...cors
      });
      res.write(`id: ${cachedEnvelope.version}\nevent: state\ndata: ${JSON.stringify(cachedEnvelope)}\n\n`);
      sseClients.add(res);
      globalMetrics.setActiveConnections(sseClients.size + wsClients.size);
      authoritySyncObserver?.clientActivity?.();
      const heartbeat=setInterval(()=>{try{res.write(': keepalive\n\n')}catch{clearInterval(heartbeat)}},15000);
      heartbeat.unref?.();
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        sseClients.delete(res);
        globalMetrics.setActiveConnections(sseClients.size + wsClients.size);
        authoritySyncObserver?.observe(cachedEnvelope);
      };
      // The request can finish while an SSE response is still open. Its `close`
      // event is not a reliable signal that the downstream listener disconnected.
      res.once('close', cleanup);
      res.once('error', cleanup);
      req.once('aborted', cleanup);
      return;
    }

    // Broadcast ingress: receives state update from authority (Netlify/admin)
    if (path === '/gateway/broadcast' && req.method === 'POST') {
      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!ADMIN_SECRET||auth !== ADMIN_SECRET) {
        return sendJson(401, { error: 'Unauthorized gateway broadcast' });
      }

      let newEnvelope;
      try {
        newEnvelope = await readJson(req);
      } catch(err) {
        return sendJson(err.status||400, { error: err.message });
      }

      if(!verifyStateEnvelope(newEnvelope))return sendJson(422,{error:'Invalid state checksum'});
      if(Number(newEnvelope.version)<Number(cachedEnvelope.version))return sendJson(409,{error:'Stale state version'});

      const delivered = broadcastState(newEnvelope);
      console.log(formatLog('info', 'gateway_broadcast_fanout', {
        requestId,
        version: newEnvelope.version,
        state: newEnvelope.state,
        fannedOutCount: delivered
      }));

      return sendJson(200, { broadcast: true, delivered, version: newEnvelope.version });
    }

    if(path==='/gateway/lock-and-drain'&&req.method==='POST'){
      const auth=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
      if(!ADMIN_SECRET||auth!==ADMIN_SECRET)return sendJson(401,{error:'Unauthorized gateway barrier'});
      if(!flusher)return sendJson(503,{error:'Durable answer sink is not configured'});
      let envelope;try{envelope=await readJson(req)}catch(err){return sendJson(err.status||400,{error:err.message})}
      if(!verifyStateEnvelope(envelope)||envelope.state!=='locked')return sendJson(422,{error:'A valid locked state envelope is required'});
      if(Number(envelope.version)<Number(cachedEnvelope.version)){
        try{await flusher.drainQueue(Number(process.env.DRAIN_TIMEOUT_MS||10000))}
        catch(err){return sendJson(503,{error:'Answer queue has not drained',detail:err.message})}
        return sendJson(200,{drained:true,stale:true,queueDepth:queue.getQueueDepth(),version:cachedEnvelope.version});
      }
      broadcastState(envelope);
      try{await flusher.drainQueue(Number(process.env.DRAIN_TIMEOUT_MS||10000))}
      catch(err){return sendJson(503,{error:'Answer queue has not drained',detail:err.message})}
      return sendJson(200,{drained:true,queueDepth:queue.getQueueDepth(),version:envelope.version});
    }

    // Answer ingress endpoint: accepts participant answers into SQLite WAL queue
    if (path === '/gateway/answers' && req.method === 'POST') {
      const ackStart = Date.now();
      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const verification = verifyParticipantCredential(auth);
      if (!verification.valid) {
        globalMetrics.recordError('UNAUTHORIZED');
        return sendJson(401, {
          error: 'Invalid or expired participant credential',
          code: verification.error || 'UNAUTHORIZED'
        });
      }

      const participantId = verification.payload.participantId;
      let b;
      try {
        b = await readJson(req);
      } catch(err) {
        return sendJson(err.status||400, { error: err.message });
      }

      if (!b.questionId || !/^[0-9a-f-]{36}$/i.test(b.idempotencyKey||'') || !Number.isInteger(b.optionIndex) || b.optionIndex<0 || b.optionIndex>3) {
        return sendJson(422, {
          error: 'Missing required answer fields (questionId, optionIndex, idempotencyKey)'
        });
      }

      if(verification.payload.eventId!==cachedEnvelope.eventId||b.sessionId&&b.sessionId!==cachedEnvelope.sessionId){
        return sendJson(409,{error:'Participant credential does not match this live session',code:'SESSION_MISMATCH'});
      }

      // Check current question state barrier
      if (cachedEnvelope.state !== 'open' || cachedEnvelope.question?.id !== b.questionId) {
        globalMetrics.recordError('QUESTION_NOT_OPEN');
        console.log(formatLog('warn', 'answer_rejected', {
          requestId,
          participantId,
          questionId: b.questionId,
          reason: 'QUESTION_NOT_OPEN',
          durationMs: Date.now() - ackStart
        }));
        return sendJson(409, { error: 'Question is not currently open for answers', code: 'QUESTION_NOT_OPEN' });
      }

      if (cachedEnvelope.deadlineAt && Date.now() > new Date(cachedEnvelope.deadlineAt).getTime()) {
        globalMetrics.recordError('ANSWER_LATE');
        console.log(formatLog('warn', 'answer_late', {
          requestId,
          participantId,
          questionId: b.questionId,
          durationMs: Date.now() - ackStart
        }));
        return sendJson(409, { error: 'The answer window has closed.', code: 'ANSWER_LATE' });
      }

      if (verification.payload.isSpectator) {
        const durationMs = Date.now() - ackStart;
        globalMetrics.recordAckLatency(durationMs);
        console.log(formatLog('info', 'spectator_answer', {
          requestId,
          participantId,
          questionId: b.questionId,
          durationMs
        }));
        return sendJson(200, {
          accepted: false,
          duplicate: false,
          spectator: true,
          practice: true,
          message: 'Practice answer only — this is not scored'
        });
      }

      try {
        const openedAt=new Date(cachedEnvelope.openedAt).getTime();
        const result = await queue.enqueueAnswer({
          participantId,
          sessionId: b.sessionId || cachedEnvelope.sessionId,
          questionId: b.questionId,
          optionIndex: b.optionIndex,
          clueNumber: cachedEnvelope.currentClue,
          responseMs: Number.isFinite(openedAt)?Math.max(0,Date.now()-openedAt):0,
          idempotencyKey: b.idempotencyKey,
          clientSubmittedAt: b.clientSubmittedAt || new Date().toISOString()
        });

        const ackDuration = Date.now() - ackStart;
        globalMetrics.recordAckLatency(ackDuration);
        globalMetrics.setQueueDepth(queue.getQueueDepth());

        console.log(formatLog('info', result.duplicate ? 'answer_duplicate' : 'answer_received', {
          requestId,
          participantId,
          questionId: b.questionId,
          answerId: result.answerId,
          durationMs: ackDuration
        }));

        return sendJson(200, {
          accepted: true,
          duplicate: result.duplicate,
          answerId: result.answerId
        });
      } catch (err) {
        globalMetrics.recordError('ENQUEUE_ERROR');
        console.error(formatLog('error', 'gateway_enqueue_failure', {
          requestId,
          participantId,
          error: err.message
        }));
        return sendJson(500, { error: 'Internal gateway ingestion error' });
      }
    }

    return sendJson(404, { error: 'Not found on gateway' });
  });

  server.queue = queue;
  server.flusher=flusher;
  server.on('close',()=>flusher?.stop());
  return server;
}

if (process.argv[1] && process.argv[1].endsWith('gateway/server.mjs')) {
  if(process.env.NODE_ENV==='production'&&(!ADMIN_SECRET||!process.env.CREDENTIAL_SECRET_ACTIVE||!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY)){
    throw new Error('Gateway production secrets and Supabase sink configuration are required');
  }
  const srv = createGatewayServer();
  const authoritySync=startAuthoritySync();
  srv.on('close',()=>authoritySync?.stop());
  srv.listen(PORT, '0.0.0.0', () => {
    console.log(`NIAC Live Gateway active on port ${PORT}`);
  });
}
