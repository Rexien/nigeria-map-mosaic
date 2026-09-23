// Provider-neutral NIAC Live Authority API
// Serves /api/* endpoints on Vercel and other cloud functions.
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { db, event, verifyAdmin } from './db.mjs';
import { createAdminSession, verifyAdminPin } from './admin-auth.mjs';
import { formatLog, getCapacityConfig } from '../lib/telemetry.mjs';
import { computeStateChecksum, createStateEnvelope } from '../lib/state-envelope.mjs';
import { signParticipantCredential } from '../lib/credentials.mjs';
import { generateSnapshots } from '../lib/snapshot-scoring.mjs';
import { createReadCache, createRateLimiter } from './traffic.mjs';

const requestContext = new AsyncLocalStorage();
const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-request-id': requestContext.getStore()?.requestId || '',
    ...headers
  },
  body: JSON.stringify(body)
});

const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ').replace(/[<>\u0000-\u001f\u007f]/g, '');
const hash = value => crypto.createHash('sha256').update(`${process.env.PARTICIPANT_TOKEN_PEPPER || ''}:${value}`).digest('hex');
const token = bytes => crypto.randomBytes(bytes).toString('base64url');
const code = () => `${token(3).slice(0, 4)}-${token(3).slice(0, 4)}`.toUpperCase();
const routeOf = e => (e.path || '').replace(/^.*\/api\/?/, '').replace(/^\/+|\/+$/g, '');
const publicReads = createReadCache(), rankingReads = createReadCache();
const rateLimit = createRateLimiter();
const clientIp = e => e.headers?.['x-real-ip'] || e.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || e.headers?.['x-nf-client-connection-ip'] || 'local';
const gatewayBase = () => String(process.env.PUBLIC_GATEWAY_URL || '').replace(/\/$/, '');
const transitions = {
  lobby: ['preparing', 'paused', 'ended'],
  preparing: ['open', 'paused', 'ended'],
  open: ['locked', 'paused'],
  locked: ['revealed', 'paused'],
  revealed: ['leaderboard', 'preparing', 'round_complete', 'paused', 'lobby'],
  leaderboard: ['preparing', 'round_complete', 'paused', 'lobby'],
  round_complete: ['lobby', 'ended'],
  paused: ['lobby', 'preparing', 'open', 'locked', 'revealed', 'leaderboard', 'ended'],
  ended: ['lobby']
};

async function dbAll(path) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await db(`${path}${path.includes('?') ? '&' : '?'}limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

async function computeAndPersistSnapshots(sessionId, version) {
  const session = (await db(`live_sessions?id=eq.${sessionId}&select=event_id`))[0];
  if (!session) throw new Error('Snapshot session not found');
  const participants = await dbAll(`participants?event_id=eq.${session.event_id}&select=id,alias,registered_at,is_spectator,is_rehearsal`);
  const raw = await dbAll(`gateway_answers?session_id=eq.${sessionId}&select=participant_id,question_id,option_index,clue_number,response_ms`);
  const legacy = await dbAll(`participant_answers?session_id=eq.${sessionId}&select=participant_id,question_id,option_index,clue_number,response_ms,is_correct,points`);
  const questionRows = await dbAll('quiz_questions?select=id,correct_option,is_void,category,quiz_rounds(day,quiz_games(activity))');
  const questions = questionRows.map(q => ({
    id: q.id,
    correct_option: q.correct_option,
    is_void: q.is_void,
    category: q.category,
    day: q.quiz_rounds?.day || 1,
    activity: q.quiz_rounds?.quiz_games?.activity || 'passport'
  }));
  const seen = new Set(legacy.map(a => `${a.participant_id}:${a.question_id}`));
  const answers = [...legacy, ...raw.filter(a => !seen.has(`${a.participant_id}:${a.question_id}`))];
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
  for (let start = 0; start < snapshots.participantScoreSnapshots.length; start += 500) {
    await db('participant_score_snapshots?on_conflict=session_id,participant_id,snapshot_version', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates',
      body: JSON.stringify(snapshots.participantScoreSnapshots.slice(start, start + 500).map(s => ({
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

async function gatewayCall(path, envelope) {
  if (!gatewayBase()) return null;
  const response = await fetch(`${gatewayBase()}/gateway/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GATEWAY_ADMIN_SECRET || ''}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(path === 'lock-and-drain' ? 12000 : 4000)
  });
  if (!response.ok) throw Object.assign(new Error(`Live gateway ${path} failed (${response.status})`), { status: 503 });
  return response.json();
}

async function gatewayHealth() {
  const limits = getCapacityConfig();
  const unavailable = (configured, statusReason) => ({
    status: configured ? 'red' : 'green',
    statusReason,
    activeConnections: 0,
    queueDepth: 0,
    p50AckMs: 0,
    p95AckMs: 0,
    errorRatePercent: 0,
    eventLoopLagMs: 0,
    limits: { testPlayers: limits.testPlayers, maxActivePlayers: limits.maxActivePlayers, queueDepthLimit: limits.queueDepthLimit }
  });
  if (!gatewayBase()) return unavailable(false, 'Direct polling mode active; system capacity normal.');
  try {
    const response = await fetch(`${gatewayBase()}/gateway/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    return health.capacity || unavailable(true, 'Gateway health metrics are unavailable.');
  } catch (error) {
    console.error(formatLog('error', 'gateway_health_failed', { error: error.message }));
    return unavailable(true, 'Gateway is unreachable; participant clients are falling back to direct polling.');
  }
}

async function pushGatewayState() {
  if (!gatewayBase()) return;
  publicReads.clear();
  const response = await buildLiveState(true);
  const envelope = JSON.parse(response.body);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await gatewayCall('broadcast', envelope);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 200 * (2 ** attempt)));
      }
    }
  }
  throw lastError;
}

async function finalizeReveal(session) {
  const lockedState = JSON.parse((await buildLiveState(true)).body);
  await gatewayCall('lock-and-drain', lockedState);
  const revealVersion = Number(session.version) + 1;
  await computeAndPersistSnapshots(session.id, revealVersion);
  const rows = await db(`live_sessions?id=eq.${session.id}&state=eq.locked`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'revealed', updated_at: new Date().toISOString(), version: revealVersion })
  });
  const revealed = rows[0] || { ...session, state: 'revealed', version: revealVersion };
  publicReads.clear();
  rankingReads.clear();
  await pushGatewayState();
  return revealed;
}

async function autoRevealSession(session) {
  if (!session || !session.deadline_at || Date.now() < new Date(session.deadline_at).getTime()) return session;
  if (session.state === 'open') {
    const rows = await db(`live_sessions?id=eq.${session.id}&state=eq.open`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'locked', updated_at: new Date().toISOString(), version: Number(session.version) + 1 })
    });
    session = rows[0] || (await db(`live_sessions?id=eq.${session.id}&select=*`))[0];
  }
  return session?.state === 'locked' ? finalizeReveal(session) : session;
}

function secureSecretMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function internalDeadline(e) {
  const expectedSecret = process.env.GATEWAY_ADMIN_SECRET || '';
  const providedSecret = bearer(e);
  if (!expectedSecret || !secureSecretMatch(providedSecret, expectedSecret)) {
    return json(401, { error: 'Unauthorized deadline callback' });
  }

  const body = JSON.parse(e.body || '{}');
  const sessionId = clean(body.sessionId);
  const questionId = clean(body.questionId);
  const expectedVersion = Number(body.version);
  if (!sessionId || !questionId || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return json(422, { error: 'sessionId, questionId, and integer version are required' });
  }

  let session = (await db(
    `live_sessions?id=eq.${encodeURIComponent(sessionId)}&select=*`
  ))[0];

  if (!session) return json(404, { error: 'Live session not found' });

  if (session.current_question_id !== questionId) {
    return json(409, {
      error: 'Stale deadline callback',
      code: 'STALE_DEADLINE',
      state: session.state,
      version: session.version
    });
  }

  if (['revealed', 'leaderboard', 'round_complete'].includes(session.state)) {
    return json(200, {
      finalized: true,
      idempotent: true,
      state: session.state,
      version: session.version
    });
  }

  const deadlineMs = new Date(session.deadline_at || '').getTime();
  if (!Number.isFinite(deadlineMs)) {
    return json(409, { error: 'Live session has no valid deadline', code: 'NO_DEADLINE' });
  }

  const now = Date.now();
  if (now < deadlineMs) {
    return json(409, {
      error: 'Deadline has not been reached',
      code: 'DEADLINE_NOT_REACHED',
      retryAfterMs: Math.max(1, deadlineMs - now)
    });
  }

  if (session.state === 'open') {
    if (Number(session.version) !== expectedVersion) {
      return json(409, {
        error: 'Stale deadline callback',
        code: 'STALE_DEADLINE',
        state: session.state,
        version: session.version
      });
    }

    const rows = await db(
      `live_sessions?id=eq.${encodeURIComponent(sessionId)}&state=eq.open&version=eq.${expectedVersion}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          state: 'locked',
          updated_at: new Date().toISOString(),
          version: expectedVersion + 1
        })
      }
    );

    session = rows[0] || (await db(
      `live_sessions?id=eq.${encodeURIComponent(sessionId)}&select=*`
    ))[0];
  }

  if (session?.state === 'locked') {
    if (session.current_question_id !== questionId || Number(session.version) !== expectedVersion + 1) {
      return json(409, {
        error: 'Stale deadline callback',
        code: 'STALE_DEADLINE',
        state: session.state,
        version: session.version
      });
    }
    const revealed = await finalizeReveal(session);
    return json(200, {
      finalized: true,
      idempotent: Number(session.version) !== expectedVersion + 1,
      state: revealed.state,
      version: revealed.version
    });
  }

  return json(409, {
    error: 'Deadline callback no longer applies to the current state',
    code: 'STALE_DEADLINE',
    state: session?.state,
    version: session?.version
  });
}

function bearer(e) {
  return String(e.headers?.authorization || e.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
}

async function adminLogin(e) {
  const body = JSON.parse(e.body || '{}');
  const pin = String(body.pin || '').trim();

  if (!/^\d{8}$/.test(pin) || !verifyAdminPin(pin)) {
    rateLimit(clientIp(e), 'admin-login-failed', 5, 10 * 60 * 1000);
    return json(401, { error: 'Invalid control code.' });
  }

  return json(200, {
    token: createAdminSession(),
    expiresInSeconds: 8 * 60 * 60,
    admin: { displayName: 'Event Team', role: 'operator' }
  });
}

async function participant(e) {
  const raw = bearer(e);
  if (!raw) throw Object.assign(new Error('Join the event first'), { status: 401 });
  const rows = await db(`participants?token_hash=eq.${hash(raw)}&select=*`);
  if (!rows[0]) throw Object.assign(new Error('Participant session is not valid'), { status: 401 });
  return rows[0];
}

async function audit(admin, ev, action, type, id, beforeData = null, afterData = null) {
  await db('admin_audit_logs', {
    method: 'POST',
    body: JSON.stringify({ event_id: ev.id, admin_user_id: admin.id, action, entity_type: type, entity_id: id, before_data: beforeData, after_data: afterData })
  });
}

async function join(e) {
  rateLimit(clientIp(e), 'join', 1500, 60000);
  const body = JSON.parse(e.body || '{}');
  const alias = clean(body.alias);
  if (alias.length < 2 || alias.length > 30 || !/[\p{L}\p{N}]/u.test(alias)) {
    return json(422, { error: 'Use a 2–30 character alias containing a letter or number.' });
  }
  const ev = await event();
  const rawToken = token(32);
  const recovery = code();
  const settings = (await db(`event_settings?event_id=eq.${ev.id}&select=*`))[0];
  const isSpectator = Boolean(settings?.roster_frozen);
  const isRehearsal = body.rehearsal === true || settings?.rehearsal_mode === true;
  const row = (await db('participants', {
    method: 'POST',
    body: JSON.stringify({
      event_id: ev.id,
      alias,
      token_hash: hash(rawToken),
      recovery_code_hash: hash(recovery),
      is_spectator: isSpectator,
      is_rehearsal: isRehearsal
    })
  }))[0];
  const credential = signParticipantCredential({ participantId: row.id, eventId: ev.id, isSpectator, isRehearsal });
  return json(200, { participant: { id: row.id, alias, isSpectator, isRehearsal }, token: rawToken, recoveryCode: recovery, credential });
}

async function recover(e) {
  const body = JSON.parse(e.body || '{}');
  const recovery = clean(body.recoveryCode).toUpperCase();
  rateLimit(clientIp(e), 'recover-network', 1500, 300000);
  rateLimit(hash(recovery), 'recover-code', 8, 300000);
  if (!/^[A-Z0-9_-]{3,6}-[A-Z0-9_-]{3,6}$/.test(recovery)) {
    return json(422, { error: 'Enter the recovery code in the format shown.' });
  }
  const rows = await db(`participants?recovery_code_hash=eq.${hash(recovery)}&select=*`);
  if (!rows[0]) return json(404, { error: 'Recovery code not found.' });
  const rawToken = token(32);
  await db(`participants?id=eq.${rows[0].id}`, {
    method: 'PATCH',
    body: JSON.stringify({ token_hash: hash(rawToken), last_seen_at: new Date().toISOString() })
  });
  const isSpectator = Boolean(rows[0].is_spectator);
  const isRehearsal = Boolean(rows[0].is_rehearsal);
  const credential = signParticipantCredential({ participantId: rows[0].id, eventId: rows[0].event_id, isSpectator, isRehearsal });
  return json(200, { participant: { id: rows[0].id, alias: rows[0].alias, isSpectator, isRehearsal }, token: rawToken, credential });
}

async function buildLiveState(skipAuto = false) {
  const ev = await event();
  const [settingsRows, sessions] = await Promise.all([
    db(`event_settings?event_id=eq.${ev.id}&select=active_activity,screen_mode`),
    db(`live_sessions?event_id=eq.${ev.id}&select=*&order=updated_at.desc&limit=1`)
  ]);
  const settings = settingsRows[0];
  const s = skipAuto ? sessions[0] : await autoRevealSession(sessions[0]);
  if (!s) {
    const envelope = createStateEnvelope({
      event: ev,
      eventId: ev.id,
      state: 'lobby',
      activity: settings?.active_activity || 'lens',
      screenMode: settings?.screen_mode || 'welcome',
      serverNow: new Date().toISOString()
    });
    return json(200, envelope);
  }
  let question = null;
  if (s.current_question_id && (s.state === 'preparing' || ['open', 'locked', 'revealed', 'leaderboard', 'round_complete'].includes(s.state))) {
    const q = (await db(`quiz_questions?id=eq.${s.current_question_id}&select=*,question_options(option_index,label),quiz_rounds(day,game_id,quiz_games(activity,title))`))[0];
    if (q) {
      const options = (q.question_options || []).slice().sort((a, b) => a.option_index - b.option_index);
      const round = q.quiz_rounds;
      const game = round?.quiz_games;
      question = {
        id: q.id,
        activity: game.activity,
        title: game.title,
        day: round.day,
        order: q.display_order || null,
        category: q.category,
        question: q.question,
        durationSeconds: q.duration_seconds,
        imageUrl: q.image_url,
        altText: q.alt_text,
        media: q.media || null,
        fallback: q.image_fallback || null,
        options: options.map(o => o.label)
      };
      if (game.activity === 'decode') {
        const d = (await db(`decode_state_rounds?round_id=eq.${q.round_id}&select=clues,clue_media,state_geo_id,reveal_fact`))[0];
        question.clueNumber = s.current_clue;
        question.clue = d?.clues?.[s.current_clue - 1] || null;
        if (d?.clue_media && d.clue_media[s.current_clue - 1]) {
          question.media = d.clue_media[s.current_clue - 1];
          question.imageUrl = question.media.src;
          question.altText = question.media.alt;
          question.fallback = question.media.fallback;
        }
        question.cluesSoFar = (d?.clues || []).slice(0, s.current_clue);
        question.clueMediaSoFar = (d?.clue_media || []).slice(0, s.current_clue);
        if (['revealed', 'leaderboard', 'round_complete'].includes(s.state)) {
          question.highlightState = d?.state_geo_id || null;
        }
      }
      if (['revealed', 'leaderboard', 'round_complete'].includes(s.state)) {
        question.correctOption = q.correct_option;
        question.explanation = q.explanation;
      }
    }
  }
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

async function liveState() {
  const response = await publicReads.get('state', 500, () => buildLiveState(false), result => {
    const s = JSON.parse(result.body);
    return s.state === 'open' ? new Date(s.deadlineAt).getTime() : Infinity;
  });
  const state = { ...JSON.parse(response.body), serverNow: new Date().toISOString() };
  const { checksum: discardedChecksum, ...payload } = state;
  return json(200, { ...payload, checksum: computeStateChecksum(payload) });
}

async function bootstrap() {
  const s = await liveState();
  const body = JSON.parse(s.body);
  return json(200, {
    state: body,
    serverNow: new Date().toISOString(),
    transport: {
      gatewaySse: gatewayBase() ? `${gatewayBase()}/gateway/stream` : null,
      gatewayAnswer: gatewayBase() ? `${gatewayBase()}/gateway/answers` : null,
      fallbackPollIntervalMs: 4000,
      reconnectJitterMaxMs: 1500
    }
  });
}

async function me(e) {
  const p = await participant(e);
  const session = (await db(`live_sessions?event_id=eq.${p.event_id}&select=*&order=updated_at.desc&limit=1`))[0];
  const version = session?.version || 1;
  const snapshot = session ? (await db(`participant_score_snapshots?session_id=eq.${session.id}&participant_id=eq.${p.id}&snapshot_version=eq.${version}&select=rank,scores,stamps`))[0] : null;
  const defaults = { day1: 0, day2: 0, combined: 0, decode: 0 };
  return json(200, {
    participant: { id: p.id, alias: p.alias, registeredAt: p.registered_at, isSpectator: Boolean(p.is_spectator) },
    scores: snapshot?.scores || defaults,
    rank: snapshot?.rank || '-',
    stamps: snapshot?.stamps || []
  });
}

async function answer(e) {
  const p = await participant(e);
  rateLimit(p.id,'answer', 12, 10000);
  const body = JSON.parse(e.body || '{}');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!uuid.test(body.sessionId||'') || !uuid.test(body.questionId||'') || !uuid.test(body.idempotencyKey||''))return json(422,{error:'Session, question and UUID idempotency key are required'});
  const s = (await db(`live_sessions?id=eq.${body.sessionId}&event_id=eq.${p.event_id}&select=*`))[0];
  if(!s || s.current_question_id!==body.questionId)return json(409,{error:'Answer does not match the active question',code:'SESSION_MISMATCH'});
  if (!s || s.state !== 'open' || !s.current_question_id) return json(409, { error: 'No question is open for answers right now' });
  if (s.deadline_at && Date.now() > new Date(s.deadline_at).getTime()) {
    await autoRevealSession(s);
    return json(409, { error: 'Answers are closed for this question' });
  }
  const option = Number(body.optionIndex);
  if (!Number.isInteger(option) || option < 0 || option > 3) return json(422, { error: 'Choose option A, B, C or D' });
  if (p.is_spectator) {
    return json(200, { recorded: true, spectator: true, message: 'Interactive answer recorded in spectator mode.' });
  }
  const result = await db('rpc/submit_raw_quiz_answer', {
    method: 'POST',
    body: JSON.stringify({
      p_session_id: s.id,
      p_token_hash: hash(bearer(e)),
      p_question_id: s.current_question_id,
      p_option_index: option,
      p_idempotency_key: body.idempotencyKey
    })
  });
  if(!result?.accepted || !result.answerId)throw Object.assign(new Error('Answer persistence was not confirmed'),{status:503});
  return json(200, { recorded:true,accepted:true,duplicate:result.duplicate===true,answerId:result.answerId,message:'Answer received — locked in.' });
}

async function lens(e) {
  const p = await participant(e);
  rateLimit(p.id, 'lens', 10, 60000);
  const body = JSON.parse(e.body || '{}');
  const text = clean(body.response || body.phrase || '');
  if (text.length < 2 || text.length > 72) return json(422, { error: 'Your lens response must be between 2 and 72 characters.' });
  const ev = await event();
  await db('lens_submissions', {
    method: 'POST',
    body: JSON.stringify({
      event_id: ev.id,
      participant_id: p.id,
      phrase: text,
      normalized_phrase: text.toLowerCase(),
      status: 'approved'
    })
  });
  publicReads.clear();
  return json(200, { submitted: true, message: 'Thank you. Your response has been added to Nigeria Through Your Lens.' });
}

async function approvedLens() {
  const ev = await event();
  const responses = await publicReads.get('lens', 1000, async () => {
    const rows = await db(`lens_submissions?event_id=eq.${ev.id}&status=eq.approved&select=id,phrase,normalized_phrase,created_at&order=created_at.desc&limit=120`);
    return (rows || []).map(r => ({ id: r.id, phrase: r.phrase, normalized_phrase: r.normalized_phrase, created_at: r.created_at }));
  });
  return json(200, {
    responses,
    items: responses.map(r => ({ id: r.id, response: r.phrase, createdAt: r.created_at }))
  });
}

async function adminLens(e, admin) {
  const ev = await event();
  const rows = await db(`lens_submissions?event_id=eq.${ev.id}&select=id,phrase,created_at,status,participants(alias)&order=created_at.desc&limit=200`);
  return json(200, { responses: rows || [] });
}

async function leaderboard(e) {
  const url = new URL(e.path || '', 'http://localhost');
  const activity = clean(e.queryStringParameters?.activity || url.searchParams.get('activity') || 'passport');
  const ev = await event();
  const session = (await db(`live_sessions?event_id=eq.${ev.id}&select=*&order=updated_at.desc&limit=1`))[0];
  const version = session?.version || 1;
  const snapshot = session ? (await db(`leaderboard_snapshots?session_id=eq.${session.id}&activity=eq.${activity}&snapshot_version=eq.${version}&select=leaders`))[0] : null;
  return json(200, { activity, leaders: snapshot?.leaders || [] });
}

async function adminData(e, admin) {
  const ev = await event();
  const session = (await db(`live_sessions?event_id=eq.${ev.id}&select=*&order=updated_at.desc&limit=1`))[0];
  const settings = (await db(`event_settings?event_id=eq.${ev.id}&select=*`))[0];
  const questions = await db('quiz_questions?select=id,display_order,category,question,correct_option,duration_seconds,explanation,source,review_status,is_void,media,image_fallback,question_options(option_index,label),quiz_rounds(day,quiz_games(activity))&order=display_order.asc');
  const participantCount = ((await db(`participants?event_id=eq.${ev.id}&select=id`, { headers: { Prefer: 'count=exact' } }))?.length) || 0;
  const responseRow = session?.current_question_id ? (await db(`live_question_state?session_id=eq.${session.id}&question_id=eq.${session.current_question_id}&select=response_count`))[0] : null;
  const gateway = await gatewayHealth();
  return json(200, {
    admin: { id: admin.id, displayName: admin.admin.display_name },
    session,
    settings,
    gateway,
    capacity: gateway,
    metrics: {
      participants: participantCount,
      responseCount: responseRow?.response_count || 0,
      activeCount: participantCount,
      spectatorCount: 0,
      rosterFrozen: Boolean(settings?.roster_frozen)
    },
    questions: questions.map(q => ({
      id: q.id,
      activity: q.quiz_rounds?.quiz_games?.activity || 'passport',
      day: q.quiz_rounds?.day,
      order: q.display_order,
      category: q.category,
      question: q.question,
      options: (q.question_options || []).slice().sort((a, b) => a.option_index - b.option_index).map(option => option.label),
      correctOption: q.correct_option,
      durationSeconds: q.duration_seconds,
      explanation: q.explanation,
      source: q.source,
      reviewStatus: q.review_status,
      isVoid: Boolean(q.is_void),
      media: q.media,
      fallback: q.image_fallback
    }))
  });
}

async function updateQuestion(e, admin) {
  const ev = await event();
  const b = JSON.parse(e.body || '{}');
  const id = clean(b.id);
  const question = clean(b.question), explanation = clean(b.explanation), source = clean(b.source);
  const options = Array.isArray(b.options) ? b.options.map(clean) : [];
  const correctOption = Number(b.correctOption), durationSeconds = Number(b.durationSeconds);
  const reviewStatus = clean(b.reviewStatus);
  const statuses = ['requires_fact_check', 'reviewed', 'approved'];

  if (!/^[0-9a-f-]{36}$/i.test(id)) return json(422, { error: 'Choose a valid question.' });
  if (!question || question.length > 500) return json(422, { error: 'The question must be between 1 and 500 characters.' });
  if (options.length!==4 || options.some(x => !x || x.length > 180)) return json(422, { error: 'Enter four answer options of 180 characters or fewer.' });
  if (!Number.isInteger(correctOption) || correctOption < 0 || correctOption > 3) return json(422, { error: 'Choose which answer is correct.' });
  if (!Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 120) return json(422, { error: 'Answer time must be between 5 and 120 seconds.' });
  if (!explanation || explanation.length > 1000) return json(422, { error: 'Add a short answer explanation.' });
  if (!source || source.length > 1000) return json(422, { error: 'Add the source used to check this question.' });
  if (!statuses.includes(reviewStatus)) return json(422, { error: 'Choose a valid review status.' });

  const before = (await db(`quiz_questions?id=eq.${id}&select=*,question_options(*)`))[0];
  if (!before) return json(404, { error: 'Question not found' });
  const liveSession = (await db(`live_sessions?event_id=eq.${ev.id}&select=current_question_id,state&order=updated_at.desc&limit=1`))[0];
  if (liveSession?.current_question_id === id && ['open', 'locked'].includes(liveSession.state)) {
    return json(409, { error: 'This question is being shown now. Close or reveal it before editing.' });
  }

  const patch = {
    question,
    correct_option: correctOption,
    duration_seconds: durationSeconds,
    explanation,
    source,
    review_status: reviewStatus,
    media: b.media || null,
    image_fallback: b.fallback || null,
    updated_at: new Date().toISOString()
  };

  const after = (await db(`quiz_questions?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) }))[0];
  for (let i = 0; i < options.length; i += 1) {
    await db(`question_options?question_id=eq.${id}&option_index=eq.${i}`, { method: 'PATCH', body: JSON.stringify({ label: options[i] }) });
  }
  await audit(admin, ev, 'update_question', 'quiz_question', id, before, after);
  const saved = (await db(`quiz_questions?id=eq.${id}&select=*,question_options(option_index,label)`))[0] || after;
  return json(200, { question: saved });
}

async function adminAction(e, admin) {
  const b = JSON.parse(e.body || '{}');
  const ev = await event();
  const openQuestionPromise = b.kind === 'open_question'
    ? db(`quiz_questions?id=eq.${b.questionId}&review_status=eq.approved&is_void=eq.false&select=*,question_options(option_index,label),quiz_rounds(day,game_id,quiz_games(activity,title))`)
    : Promise.resolve(null);
  const [sessionRows, openQuestionRows] = await Promise.all([
    db(`live_sessions?event_id=eq.${ev.id}&select=*&order=updated_at.desc&limit=1`),
    openQuestionPromise
  ]);
  let session = sessionRows[0];

  if (b.kind === 'show_welcome') {
    if (session?.state === 'open') {
      return json(409, { error: 'Wait for the current question to close before showing Welcome.' });
    }
    const now = new Date().toISOString();
    await db(`event_settings?event_id=eq.${ev.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ screen_mode: 'welcome', updated_at: now })
    });
    let afterSession = session;
    if (session) {
      afterSession = (await db(`live_sessions?id=eq.${session.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          state: 'lobby',
          current_question_id: null,
          current_round_id: null,
          current_clue: 1,
          opened_at: null,
          deadline_at: null,
          updated_at: now,
          version: session.version + 1
        })
      }))[0];
    }
    await audit(admin, ev, 'show_welcome', 'live_session', session?.id || ev.id, session, afterSession);
    return json(200, { session: afterSession });
  }

  if (b.kind === 'set_settings') {
    const currentSettings = (await db(`event_settings?event_id=eq.${ev.id}&select=*`))[0];
    const isChangingActivity = Boolean(b.activeActivity && b.activeActivity !== currentSettings?.active_activity);

    if (session?.state === 'open' && isChangingActivity) {
      return json(409, { error: 'Wait for the current question to close before changing activities.' });
    }

    const patch = {};
    if (['lens', 'passport', 'decode'].includes(b.activeActivity)) {
      patch.active_activity = b.activeActivity;
      patch.screen_mode = 'activity';
    }
    if (typeof b.rehearsalMode === 'boolean') patch.rehearsal_mode = b.rehearsalMode;
    if (typeof b.rosterFrozen === 'boolean') patch.roster_frozen = b.rosterFrozen;
    patch.updated_at = new Date().toISOString();

    if (session && isChangingActivity) {
      await db(`live_sessions?id=eq.${session.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          state: 'lobby',
          current_question_id: null,
          current_round_id: null,
          current_clue: 1,
          opened_at: null,
          deadline_at: null,
          updated_at: new Date().toISOString(),
          version: session.version + 1
        })
      });
    }

    const after = (await db(`event_settings?event_id=eq.${ev.id}`, { method: 'PATCH', body: JSON.stringify(patch) }))[0];
    await audit(admin, ev, 'update_settings', 'event_settings', ev.id, currentSettings, after);
    return json(200, { settings: after });
  }

  if (b.kind === 'toggle_roster_freeze') {
    const currentSettings = (await db(`event_settings?event_id=eq.${ev.id}&select=*`))[0];
    const newFrozen = !currentSettings?.roster_frozen;
    const after = (await db(`event_settings?event_id=eq.${ev.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ roster_frozen: newFrozen, updated_at: new Date().toISOString() })
    }))[0];
    await audit(admin, ev, 'toggle_roster_freeze', 'event_settings', ev.id, currentSettings, after);
    return json(200, { settings: after });
  }

  if (b.kind === 'moderate') {
    const id = clean(b.id);
    const existing = (await db(`lens_submissions?id=eq.${encodeURIComponent(id)}&select=*`))[0];
    if (!existing) return json(404, { error: 'Response not found' });
    const patch = {};
    if (['approved', 'hidden', 'rejected', 'pending'].includes(b.status)) patch.status = b.status;
    if (b.phrase) {
      const phrase = clean(b.phrase).slice(0, 72);
      if (phrase.length >= 1) {
        patch.phrase = phrase;
        patch.normalized_phrase = phrase.toLowerCase();
      }
    }
    patch.reviewed_at = new Date().toISOString();
    const after = (await db(`lens_submissions?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    }))[0];
    publicReads.clear();
    await audit(admin, ev, 'moderate_lens', 'lens_submission', id, existing, after);
    return json(200, { response: after });
  }

  if (b.kind === 'clear_data') {
    if (!['CLEAR REHEARSAL DATA', 'RESET NIAC 2026 PRODUCTION DATA'].includes(b.confirmText)) {
      return json(422, { error: 'Confirmation did not match.' });
    }
    let clearedCount = 0;
    if (b.scope === 'rehearsal') {
      if (b.confirmText !== 'CLEAR REHEARSAL DATA') return json(422, { error: 'Confirmation did not match rehearsal scope.' });
      if (session && ['open', 'locked'].includes(session.state)) return json(409, { error: 'Finish revealing the current question before clearing rehearsal data.' });
      const rehearsalParticipants = await dbAll(`participants?event_id=eq.${ev.id}&is_rehearsal=eq.true&select=id`);
      clearedCount = rehearsalParticipants?.length || 0;
      for (let start = 0; start < clearedCount; start += 100) {
        const ids = rehearsalParticipants.slice(start, start + 100).map(p => encodeURIComponent(p.id)).join(',');
        // These two legacy foreign keys intentionally have no ON DELETE CASCADE.
        // Delete only dependents of the enumerated rehearsal identities.
        for (const table of ['participant_answers', 'lens_submissions']) {
          await db(`${table}?participant_id=in.(${ids})`, { method: 'DELETE' });
        }
        await db(`participants?event_id=eq.${ev.id}&is_rehearsal=eq.true&id=in.(${ids})`, { method: 'DELETE' });
      }
      publicReads.clear();
      rankingReads.clear();
    } else if (b.scope === 'production' && b.confirmText === 'RESET NIAC 2026 PRODUCTION DATA') {
      const allParticipants = await db(`participants?event_id=eq.${ev.id}&select=id`);
      clearedCount = allParticipants?.length || 0;
      if (clearedCount > 0) {
        await db(`participants?event_id=eq.${ev.id}`, { method: 'DELETE' });
      }
      if (session) {
        await db(`live_sessions?id=eq.${session.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            state: 'lobby',
            current_question_id: null,
            current_round_id: null,
            current_clue: 1,
            opened_at: null,
            deadline_at: null,
            updated_at: new Date().toISOString(),
            version: session.version + 1
          })
        });
      }
      await db(`live_question_state?session_id=eq.${session?.id}`, { method: 'DELETE' });
    }
    await audit(admin, ev, 'clear_data', 'event', ev.id, { scope: b.scope }, { cleared: clearedCount });
    return json(200, { cleared: clearedCount, scope: b.scope });
  }

  if (!session) return json(404, { error: 'No live session found' });
  if (b.kind === 'open_question') {
    const q = openQuestionRows?.[0];
    if (!q) return json(422, { error: 'Only approved, non-void questions can be opened.' });
    if (session.state === 'open') return json(409, { error: 'A question is already open.' });
    if (session.state === 'ended') return json(409, { error: 'Return to the welcome screen before opening a question.' });
    const now = new Date(), activity = q.quiz_rounds?.quiz_games?.activity || 'passport';
    const clueNum = activity === 'decode' ? (session.current_question_id === q.id && session.current_clue ? session.current_clue : 3) : 1;
    const after = (await db(`live_sessions?id=eq.${session.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        current_question_id: q.id,
        current_round_id: q.round_id,
        current_clue: clueNum,
        state: 'open',
        opened_at: now.toISOString(),
        deadline_at: new Date(now.getTime() + (q.duration_seconds || 20) * 1000).toISOString(),
        updated_at: now.toISOString(),
        version: session.version + 1
      })
    }))[0];
    const decodePromise = activity === 'decode'
      ? db(`decode_state_rounds?round_id=eq.${q.round_id}&select=clues,clue_media,state_geo_id,reveal_fact`)
      : Promise.resolve(null);
    const [, , decodeRows] = await Promise.all([
      db('live_question_state', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=representation',
        body: JSON.stringify({ session_id: session.id, question_id: q.id, response_count: 0 })
      }),
      db(`event_settings?event_id=eq.${ev.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active_activity: activity, screen_mode: 'activity', updated_at: now.toISOString() })
      }),
      decodePromise,
      audit(admin, ev, 'open_question', 'live_session', session.id, session, after)
    ]);
    const round = q.quiz_rounds;
    const game = round?.quiz_games;
    const options = (q.question_options || []).slice().sort((a, b) => a.option_index - b.option_index);
    const question = {
      id: q.id,
      activity: game?.activity || activity,
      title: game?.title,
      day: round?.day,
      order: q.display_order || null,
      category: q.category,
      question: q.question,
      durationSeconds: q.duration_seconds,
      imageUrl: q.image_url,
      altText: q.alt_text,
      media: q.media || null,
      fallback: q.image_fallback || null,
      options: options.map(option => option.label)
    };
    if (activity === 'decode') {
      const decode = decodeRows?.[0];
      question.clueNumber = clueNum;
      question.clue = decode?.clues?.[clueNum - 1] || null;
      if (decode?.clue_media?.[clueNum - 1]) {
        question.media = decode.clue_media[clueNum - 1];
        question.imageUrl = question.media.src;
        question.altText = question.media.alt;
        question.fallback = question.media.fallback;
      }
      question.cluesSoFar = (decode?.clues || []).slice(0, clueNum);
      question.clueMediaSoFar = (decode?.clue_media || []).slice(0, clueNum);
    }
    const result = json(200, { session: after });
    result.gatewayEnvelope = createStateEnvelope({
      event: ev,
      eventId: ev.id,
      sessionId: after.id,
      version: after.version,
      state: after.state,
      activity,
      screenMode: 'activity',
      currentClue: after.current_clue,
      openedAt: after.opened_at,
      deadlineAt: after.deadline_at,
      responseCount: 0,
      serverNow: new Date().toISOString()
    }, question);
    return result;
  }
  if (b.kind === 'select_question') {
    const q = (await db(`quiz_questions?id=eq.${b.questionId}&review_status=eq.approved&is_void=eq.false&select=id,round_id`))[0];
    if (!q) return json(422, { error: 'Only approved, non-void questions can be selected.' });
    if (session.state === 'open') return json(409, { error: 'Lock the current question before selecting another.' });
    const after = (await db(`live_sessions?id=eq.${session.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        current_question_id: q.id,
        current_round_id: q.round_id,
        current_clue: 1,
        state: 'preparing',
        opened_at: null,
        deadline_at: null,
        updated_at: new Date().toISOString(),
        version: session.version + 1
      })
    }))[0];
    await db(`event_settings?event_id=eq.${ev.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active_activity: 'decode', screen_mode: 'activity', updated_at: new Date().toISOString() })
    });
    await audit(admin, ev, 'select_question', 'live_session', session.id, session, after);
    return json(200, { session: after });
  }
  if (b.kind === 'void_question') {
    if (!session.current_question_id) return json(409, { error: 'No question is selected.' });
    const before = (await db(`quiz_questions?id=eq.${session.current_question_id}&select=*`))[0];
    await db('rpc/void_quiz_question', {
      method: 'POST',
      body: JSON.stringify({ p_question_id: session.current_question_id })
    });
    const after = (await db(`quiz_questions?id=eq.${session.current_question_id}&select=*`))[0];
    await audit(admin, ev, 'void_question', 'quiz_question', session.current_question_id, before, after);
    return json(200, { question: after });
  }
  if (b.kind === 'next_clue') {
    if (session.current_clue >= 3) return json(409, { error: 'The third clue is already showing.' });
    const after = (await db(`live_sessions?id=eq.${session.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ current_clue: session.current_clue + 1, updated_at: new Date().toISOString(), version: session.version + 1 })
    }))[0];
    await audit(admin, ev, 'next_clue', 'live_session', session.id, session, after);
    return json(200, { session: after });
  }
  const allowed = ['lobby', 'preparing', 'open', 'locked', 'revealed', 'leaderboard', 'round_complete', 'paused', 'ended'];
  if (!allowed.includes(b.state)) return json(422, { error: 'Invalid state' });
  if (!transitions[session.state]?.includes(b.state)) return json(409, { error: `Cannot move directly from ${session.state} to ${b.state}.` });
  const patch = { state: b.state, updated_at: new Date().toISOString(), version: session.version + 1 };
  if (b.state === 'paused') patch.resume_state = session.state;
  if (b.state === 'lobby') {
    patch.current_question_id = null;
    patch.current_round_id = null;
    patch.current_clue = 1;
    patch.opened_at = null;
    patch.deadline_at = null;
  }
  if (b.state === 'open') {
    if (!session.current_question_id) return json(409, { error: 'Select an approved question first.' });
    const q = (await db(`quiz_questions?id=eq.${session.current_question_id}&select=duration_seconds`))[0];
    patch.opened_at = new Date().toISOString();
    patch.deadline_at = new Date(Date.now() + (Number(b.durationSeconds) || q?.duration_seconds || 20) * 1000).toISOString();
    await db('live_question_state', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: JSON.stringify({ session_id: session.id, question_id: session.current_question_id, response_count: 0 })
    });
  }
  if (b.state === 'revealed') {
    const lockedState = JSON.parse((await buildLiveState(true)).body);
    await gatewayCall('lock-and-drain', lockedState);
    await computeAndPersistSnapshots(session.id, patch.version);
  }
  const after = (await db(`live_sessions?id=eq.${session.id}`, { method: 'PATCH', body: JSON.stringify(patch) }))[0];
  await audit(admin, ev, 'set_live_state', 'live_session', session.id, session, after);
  return json(200, { session: after });
}

export async function handler(e) {
  const requestId = e.headers?.['x-request-id'] || e.headers?.['X-Request-Id'] || crypto.randomUUID();
  return requestContext.run({ requestId }, async () => {
    const startAt = Date.now();
    try {
      if (e.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: { allow: 'GET,POST,PATCH,OPTIONS', 'x-request-id': requestId } };
      }
      const route = routeOf(e);
      const method = e.httpMethod;
      let res, mutated = false;

      // Health endpoint (Requirement 13)
      if (method === 'GET' && route === 'health') {
        res = json(200, { status: 'ok', service: 'niac-live-authority' });
      } else if (method === 'POST' && route === 'participants') {
        res = await join(e);
      } else if (method === 'POST' && route === 'recover') {
        res = await recover(e);
      } else if (method === 'GET' && route === 'bootstrap') {
        res = await bootstrap();
      } else if (method === 'GET' && route === 'state') {
        res = await liveState();
      } else if (method === 'GET' && route === 'me') {
        res = await me(e);
      } else if (method === 'POST' && route === 'answers') {
        res = await answer(e);
      } else if (method === 'POST' && route === 'lens') {
        res = await lens(e);
      } else if (method === 'GET' && route === 'lens/approved') {
        res = await approvedLens();
      } else if (method === 'GET' && route === 'leaderboard') {
        res = await leaderboard(e);
      } else if (method === 'POST' && route === 'admin/login') {
        res = await adminLogin(e);
      } else if (method === 'POST' && route === 'internal/deadline') {
        res = await internalDeadline(e);
      } else if (method === 'GET' && route === 'admin/lens') {
        const admin = await verifyAdmin(e.headers?.authorization);
        res = await adminLens(e, admin);
      } else if (route.startsWith('admin/')) {
        const admin = await verifyAdmin(e.headers?.authorization);
        if (method === 'GET') {
          res = await adminData(e, admin);
        } else if (method === 'POST') {
          res = await adminAction(e, admin);
          mutated = true;
        } else if (method === 'PATCH' && route==='admin/question') {
          res = await updateQuestion(e, admin);
          mutated = true;
        }
      }

      if (mutated) {
        publicReads.clear();
        rankingReads.clear();
        const gatewayEnvelope = res?.gatewayEnvelope;
        if (res?.gatewayEnvelope) delete res.gatewayEnvelope;
        try {
          if (gatewayEnvelope) await gatewayCall('broadcast', gatewayEnvelope);
          else await pushGatewayState();
        } catch (error) {
          console.error(formatLog('error', 'gateway_broadcast_failed', { requestId, error: error.message }));
        }
      }

      if (res) {
        console.log(formatLog('info', 'api_request', { requestId, method, route, statusCode: res.statusCode, durationMs: Date.now() - startAt }));
        return res;
      }
      return json(404, { error: 'Not found' });
    } catch (err) {
      console.error(formatLog('error', 'api_error', { requestId, error: err.message, status: err.status || 500, durationMs: Date.now() - startAt }));
      return json(err.status || 500, {
        error: err.status && err.status < 500 ? err.message : 'The event service could not complete that request.',
        code: err.status === 503 ? 'GATEWAY_NOT_READY' : 'REQUEST_FAILED'
      });
    }
  });
}

// Node.js HTTP req/res adapter for Vercel Serverless Functions
export async function handleNodeRequest(req, res) {
  let bodyStr = null;
  if (req.body !== undefined && req.body !== null) {
    bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodyStr = Buffer.concat(chunks).toString('utf8');
  }

  const host = req.headers['host'] || 'localhost';
  const url = new URL(req.url || '/', `http://${host}`);
  const queryParams = { ...Object.fromEntries(url.searchParams.entries()) };
  if (req.query && typeof req.query === 'object') {
    for (const [k, v] of Object.entries(req.query)) {
      if (k !== 'path') queryParams[k] = v;
    }
  }

  let pathname = url.pathname;
  if ((pathname === '/api' || pathname === '/api/') && req.query?.path) {
    const segments = Array.isArray(req.query.path) ? req.query.path : [req.query.path];
    pathname = '/api/' + segments.join('/');
  }

  const event = {
    httpMethod: req.method || 'GET',
    path: pathname,
    headers: req.headers || {},
    queryStringParameters: queryParams,
    body: bodyStr
  };

  const result = await handler(event);

  for (const [key, value] of Object.entries(result.headers || {})) {
    res.setHeader(key, value);
  }
  res.statusCode = result.statusCode || 200;
  res.end(result.body);
}
