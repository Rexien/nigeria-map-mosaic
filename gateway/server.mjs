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
  const payload = `id: ${envelope.version}\nevent: state\ndata: ${JSON.stringify(envelope)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
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

export function startAuthoritySync(options={}){
  const baseUrl=options.baseUrl||process.env.AUTHORITY_BASE_URL||process.env.PUBLIC_EVENT_URL;
  if(!baseUrl)return null;
  const intervalMs=Math.max(1000,Number(options.intervalMs||process.env.AUTHORITY_POLL_MS||2000));
  let timer=null,stopped=false,running=false;
  const run=async()=>{
    if(stopped||running)return;
    running=true;
    try{await refreshAuthorityState(baseUrl)}
    catch(error){globalMetrics.recordError('AUTHORITY_SYNC');console.error(formatLog('error','authority_sync_failed',{error:error.message}))}
    finally{running=false;if(!stopped)timer=setTimeout(run,intervalMs)}
  };
  void run();
  return {stop(){stopped=true;if(timer)clearTimeout(timer)}};
}

export function createSupabaseSink(url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY){
  if(!url||!key)return null;
  return async items=>{
    const response=await fetch(`${url}/rest/v1/gateway_answers?on_conflict=participant_id,question_id`,{
      method:'POST',
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
    const cors=allowedOrigin&&(allowedOrigin==='*'||origin===allowedOrigin)?{'access-control-allow-origin':allowedOrigin==='*'?'*':origin,'vary':'Origin'}:{};
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
      const heartbeat=setInterval(()=>{try{res.write(': keepalive\n\n')}catch{clearInterval(heartbeat)}},15000);
      heartbeat.unref?.();
      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
        globalMetrics.setActiveConnections(sseClients.size + wsClients.size);
      });
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
