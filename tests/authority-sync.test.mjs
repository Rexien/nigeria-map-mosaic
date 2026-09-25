import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import {
  broadcastState,
  getCachedState,
  notifyAuthorityDeadline,
  resetClients,
  setCachedEnvelope,
  sseClients,
  startAuthoritySync
} from '../gateway/server.mjs';
import { createStateEnvelope } from '../lib/state-envelope.mjs';
import { handler as authorityHandler } from '../server/api.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('Timed out waiting for condition');
}

function question(id) {
  return { id, question: 'Test?', options: ['A', 'B', 'C', 'D'] };
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

test('authority sync fetches once at startup and does not continuously poll an idle gateway with no clients', async () => {
  resetClients();
  setCachedEnvelope(createStateEnvelope({ eventId: 'event-idle', sessionId: 'idle-session', state: 'lobby', version: 1 }));
  let stateCalls = 0;
  const envelope = createStateEnvelope({ eventId: 'event-idle', sessionId: 'idle-session', state: 'lobby', version: 2 });
  const authority = createHttpServer((req, res) => {
    if (req.url === '/api/state') {
      stateCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(envelope));
    }
    res.writeHead(404).end();
  });
  const baseUrl = await listen(authority);
  const sync = startAuthoritySync({ baseUrl, secret: 'test-secret', reconcileMs: 30 });
  try {
    await waitFor(() => stateCalls === 1);
    await sleep(100);
    assert.equal(stateCalls, 1);
  } finally {
    sync?.stop();
    await close(authority);
    resetClients();
  }
});

test('revealed state fans out before gateway starts a retried scoring callback', async () => {
  resetClients();
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const questionId = '44444444-4444-4444-8444-444444444444';
  const envelope = createStateEnvelope({ eventId: 'event-score', sessionId, state: 'revealed', version: 6 },
    { ...question(questionId), correctOption: 1 });
  setCachedEnvelope(createStateEnvelope({ eventId: 'event-score', sessionId, state: 'lobby', version: 1 }));
  const order = [];
  const scoreBodies = [];
  sseClients.add({ write() { order.push('fanout'); } });
  const authority = createHttpServer(async (req, res) => {
    if (req.url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(envelope));
    }
    if (req.url === '/api/internal/score') {
      order.push('score');
      assert.equal(req.headers.authorization, 'Bearer score-secret');
      let body = '';
      for await (const chunk of req) body += chunk;
      scoreBodies.push(JSON.parse(body));
      res.writeHead(scoreBodies.length === 1 ? 503 : 200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(scoreBodies.length === 1 ? { error: 'retry me' } : { scored: true }));
    }
    res.writeHead(404).end();
  });
  const baseUrl = await listen(authority);
  const sync = startAuthoritySync({ baseUrl, secret: 'score-secret', retryBaseMs: 10, reconcileMs: 60000 });
  try {
    await waitFor(() => scoreBodies.length === 2);
    assert.equal(order[0], 'fanout');
    assert.deepEqual(scoreBodies[0], { sessionId, questionId, version: 6 });
    assert.equal(scoreBodies.length, 2, 'transient scoring failure should retry');
  } finally {
    sync?.stop();
    await close(authority);
    resetClients();
  }
});

test('open state schedules authenticated deadline callback and retries transient failure before reconciling', async () => {
  resetClients();
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const questionId = '22222222-2222-4222-8222-222222222222';
  let current = createStateEnvelope({
    eventId: 'event-open',
    sessionId,
    state: 'open',
    version: 3,
    openedAt: new Date(Date.now() - 1000).toISOString(),
    deadlineAt: new Date(Date.now() + 70).toISOString()
  }, question(questionId));
  setCachedEnvelope(createStateEnvelope({ eventId: 'event-open', sessionId, state: 'lobby', version: 1 }));

  let stateCalls = 0;
  let deadlineCalls = 0;
  const deadlineBodies = [];
  const authority = createHttpServer(async (req, res) => {
    if (req.url === '/api/state') {
      stateCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(current));
    }
    if (req.url === '/api/internal/deadline' && req.method === 'POST') {
      deadlineCalls += 1;
      assert.equal(req.headers.authorization, 'Bearer test-secret');
      let body = '';
      for await (const chunk of req) body += chunk;
      deadlineBodies.push(JSON.parse(body));
      if (deadlineCalls === 1) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'temporary authority failure' }));
      }
      current = createStateEnvelope({
        eventId: 'event-open',
        sessionId,
        state: 'revealed',
        version: 5
      }, { ...question(questionId), correctOption: 1, explanation: 'Done' });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ finalized: true, state: 'revealed', version: 5 }));
    }
    res.writeHead(404).end();
  });
  const baseUrl = await listen(authority);
  const sync = startAuthoritySync({
    baseUrl,
    secret: 'test-secret',
    reconcileMs: 1000,
    retryBaseMs: 20,
    retryMaxMs: 40,
    maxDeadlineAttempts: 4
  });
  try {
    await waitFor(() => deadlineCalls >= 2, 1200);
    await waitFor(() => getCachedState().state === 'revealed', 500);
    assert.equal(deadlineBodies[0].sessionId, sessionId);
    assert.equal(deadlineBodies[0].questionId, questionId);
    assert.equal(deadlineBodies[0].version, 3);
    assert.ok(stateCalls >= 2, 'gateway should reconcile state after successful deadline finalization');
  } finally {
    sync?.stop();
    await close(authority);
    resetClients();
  }
});

test('newer pushed state cancels an older local deadline timer', async () => {
  resetClients();
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const oldQuestionId = '44444444-4444-4444-8444-444444444444';
  const newQuestionId = '55555555-5555-4555-8555-555555555555';
  const open = createStateEnvelope({
    eventId: 'event-cancel',
    sessionId,
    state: 'open',
    version: 10,
    openedAt: new Date(Date.now() - 100).toISOString(),
    deadlineAt: new Date(Date.now() + 140).toISOString()
  }, question(oldQuestionId));
  let stateCalls = 0;
  let deadlineCalls = 0;
  const authority = createHttpServer(async (req, res) => {
    if (req.url === '/api/state') {
      stateCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(open));
    }
    if (req.url === '/api/internal/deadline') {
      deadlineCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ finalized: true }));
    }
    res.writeHead(404).end();
  });
  const baseUrl = await listen(authority);
  setCachedEnvelope(createStateEnvelope({ eventId: 'event-cancel', sessionId, state: 'lobby', version: 1 }));
  const sync = startAuthoritySync({ baseUrl, secret: 'test-secret', reconcileMs: 1000 });
  try {
    await waitFor(() => stateCalls === 1);
    await sleep(20);
    broadcastState(createStateEnvelope({
      eventId: 'event-cancel',
      sessionId,
      state: 'preparing',
      version: 11
    }, question(newQuestionId)));
    await sleep(180);
    assert.equal(deadlineCalls, 0);
  } finally {
    sync?.stop();
    await close(authority);
    resetClients();
  }
});

test('live client activity triggers debounced reconciliation while empty idle gateway stays quiet', async () => {
  resetClients();
  const sessionId = '66666666-6666-4666-8666-666666666666';
  const envelope = createStateEnvelope({ eventId: 'event-client', sessionId, state: 'lobby', version: 2 });
  let stateCalls = 0;
  const authority = createHttpServer((req, res) => {
    if (req.url === '/api/state') {
      stateCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(envelope));
    }
    res.writeHead(404).end();
  });
  const baseUrl = await listen(authority);
  setCachedEnvelope(createStateEnvelope({ eventId: 'event-client', sessionId, state: 'lobby', version: 1 }));
  const sync = startAuthoritySync({
    baseUrl,
    secret: 'test-secret',
    reconcileMs: 40,
    clientReconcileMinGapMs: 1000
  });
  try {
    await waitFor(() => stateCalls === 1);
    sseClients.add({ write() {} });
    sync.clientActivity();
    sync.clientActivity();
    await waitFor(() => stateCalls >= 2);
    const afterImmediate = stateCalls;
    await sleep(100);
    assert.ok(stateCalls > afterImmediate, 'connected clients should keep a slow reconciliation watchdog active');
    sseClients.clear();
    sync.observe(getCachedState());
    await sleep(50);
    const afterDisconnect = stateCalls;
    await sleep(100);
    assert.equal(stateCalls, afterDisconnect, 'idle gateway without clients should stop continuous reconciliation');
  } finally {
    sync?.stop();
    await close(authority);
    resetClients();
  }
});

test('deadline callback helper refuses to run without shared secret', async () => {
  const envelope = createStateEnvelope({
    eventId: 'event-secret',
    sessionId: '77777777-7777-4777-8777-777777777777',
    state: 'open',
    version: 2,
    deadlineAt: new Date().toISOString()
  }, question('88888888-8888-4888-8888-888888888888'));
  await assert.rejects(
    () => notifyAuthorityDeadline(envelope, { baseUrl: 'http://127.0.0.1:9', secret: '' }),
    /secret/i
  );
});

test('authority deadline route requires gateway secret and rejects malformed or stale callbacks before finalization', async () => {
  const previous = {
    GATEWAY_ADMIN_SECRET: process.env.GATEWAY_ADMIN_SECRET,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  const realFetch = global.fetch;
  process.env.GATEWAY_ADMIN_SECRET = 'deadline-secret';
  process.env.SUPABASE_URL = 'https://db.example';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

  try {
    let result = await authorityHandler({
      httpMethod: 'POST',
      path: '/api/internal/deadline',
      headers: { authorization: 'Bearer wrong-secret' },
      body: JSON.stringify({})
    });
    assert.equal(result.statusCode, 401);

    result = await authorityHandler({
      httpMethod: 'POST',
      path: '/api/internal/deadline',
      headers: { authorization: 'Bearer deadline-secret' },
      body: JSON.stringify({})
    });
    assert.equal(result.statusCode, 422);

    global.fetch = async url => {
      assert.match(String(url), /live_sessions\?id=eq\./);
      return new Response(JSON.stringify([{
        id: '99999999-9999-4999-8999-999999999999',
        current_question_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        state: 'open',
        version: 9,
        deadline_at: new Date(Date.now() - 1000).toISOString()
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    result = await authorityHandler({
      httpMethod: 'POST',
      path: '/api/internal/deadline',
      headers: { authorization: 'Bearer deadline-secret' },
      body: JSON.stringify({
        sessionId: '99999999-9999-4999-8999-999999999999',
        questionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        version: 9
      })
    });
    assert.equal(result.statusCode, 409);
    assert.equal(JSON.parse(result.body).code, 'STALE_DEADLINE');
  } finally {
    global.fetch = realFetch;
    if (previous.GATEWAY_ADMIN_SECRET === undefined) delete process.env.GATEWAY_ADMIN_SECRET;
    else process.env.GATEWAY_ADMIN_SECRET = previous.GATEWAY_ADMIN_SECRET;
    if (previous.SUPABASE_URL === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previous.SUPABASE_URL;
    if (previous.SUPABASE_SERVICE_ROLE_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.SUPABASE_SERVICE_ROLE_KEY;
  }
});
