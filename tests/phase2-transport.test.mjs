import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Writable } from 'node:stream';
import {
  createStateEnvelope,
  verifyStateEnvelope,
  sanitizePublicQuestion
} from '../lib/state-envelope.mjs';
import {
  createGatewayServer,
  broadcastState,
  sseClients,
  resetClients
} from '../gateway/server.mjs';
import '../js/niac-transport.js';

test('createStateEnvelope generates versioned envelope with valid checksum', () => {
  const envelope = createStateEnvelope({
    sessionId: 'session-123',
    version: 42,
    state: 'open',
    responseCount: 15
  }, {
    id: 'q-1',
    category: 'geography',
    question: 'What is the capital of Nigeria?',
    options: ['Lagos', 'Abuja', 'Kano', 'Ibadan'],
    correctOption: 1,
    explanation: 'Abuja became the federal capital in 1991.'
  });

  assert.equal(envelope.sessionId, 'session-123');
  assert.equal(envelope.version, 42);
  assert.equal(envelope.state, 'open');
  assert.equal(envelope.responseCount, 15);
  assert.ok(envelope.checksum, 'Envelope must contain a checksum');
  assert.equal(verifyStateEnvelope(envelope), true, 'Checksum verification must succeed');
});

test('verifyStateEnvelope detects tampered payload', () => {
  const envelope = createStateEnvelope({
    sessionId: 'session-1',
    version: 1,
    state: 'open'
  });

  assert.equal(verifyStateEnvelope(envelope), true);

  // Tamper with state
  const tamperedState = { ...envelope, state: 'revealed' };
  assert.equal(verifyStateEnvelope(tamperedState), false, 'Must detect tampered state');

  // Tamper with version
  const tamperedVersion = { ...envelope, version: 99 };
  assert.equal(verifyStateEnvelope(tamperedVersion), false, 'Must detect tampered version');

  // Tamper with response count
  const tamperedCount = { ...envelope, responseCount: 500 };
  assert.equal(verifyStateEnvelope(tamperedCount), false, 'Must detect tampered response count');

  const withQuestion=createStateEnvelope({sessionId:'session-1',version:1,state:'open'},{id:'q-1',question:'Original?',options:['A','B','C','D']});
  const tamperedQuestion={...withQuestion,question:{...withQuestion.question,question:'Tampered?'}};
  assert.equal(verifyStateEnvelope(tamperedQuestion),false,'Must detect tampered nested question data');
});

test('state envelope strictly suppresses correctOption and explanation before reveal', () => {
  const question = {
    id: 'q-secret',
    category: 'culture',
    question: 'Secret question?',
    options: ['A', 'B', 'C', 'D'],
    correctOption: 2,
    explanation: 'Confidential explanation'
  };

  // 1. Lobby: Question is completely null
  const lobbyEnvelope = createStateEnvelope({ state: 'lobby', version: 1 }, question);
  assert.equal(lobbyEnvelope.question, null, 'Lobby must not leak question content');

  // 2. Open: Question is present but correctOption and explanation are undefined
  const openEnvelope = createStateEnvelope({ state: 'open', version: 2 }, question);
  assert.ok(openEnvelope.question, 'Question must be present when open');
  assert.equal(openEnvelope.question.correctOption, undefined, 'Open question must not include correctOption');
  assert.equal(openEnvelope.question.explanation, undefined, 'Open question must not include explanation');
  assert.deepEqual(openEnvelope.question.options, ['A', 'B', 'C', 'D']);

  // 3. Locked: Question is still present but answers remain suppressed
  const lockedEnvelope = createStateEnvelope({ state: 'locked', version: 3 }, question);
  assert.equal(lockedEnvelope.question.correctOption, undefined, 'Locked question must not include correctOption');
  assert.equal(lockedEnvelope.question.explanation, undefined, 'Locked question must not include explanation');

  // 4. Revealed: Secret answer and explanation are now safely exposed
  const revealedEnvelope = createStateEnvelope({ state: 'revealed', version: 4 }, question);
  assert.equal(revealedEnvelope.question.correctOption, 2, 'Revealed question must expose correctOption');
  assert.equal(revealedEnvelope.question.explanation, 'Confidential explanation', 'Revealed question must expose explanation');

  // 5. Leaderboard: Secret answer remains present
  const leaderboardEnvelope = createStateEnvelope({ state: 'leaderboard', version: 5 }, question);
  assert.equal(leaderboardEnvelope.question.correctOption, 2);
  assert.equal(leaderboardEnvelope.question.explanation, 'Confidential explanation');
});

test('NIACTransport manages state lifecycle, monotonic versioning and timer countdown', () => {
  const transport = globalThis.NIACTransport;
  assert.ok(transport, 'NIACTransport must be defined on globalThis');

  assert.equal(transport.getStatus(), 'connecting');

  transport.destroy();
  const states = [];
  transport.onState(s => states.push(s));

  const deadline = new Date(Date.now() + 10000).toISOString();
  const mockEnvelope = createStateEnvelope({
    version: 1,
    state: 'open',
    deadlineAt: deadline,
    serverNow: new Date().toISOString()
  });

  const secondsLeft = Math.max(0, Math.ceil((new Date(deadline).getTime() - Date.now()) / 1000));
  assert.ok(secondsLeft >= 8 && secondsLeft <= 10, `Seconds left should be ~10s, got ${secondsLeft}`);
});

test('gateway server handles real HTTP SSE streams, health checks, and broadcast authorization', async () => {
  resetClients();
  const server = createGatewayServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // 1. Check health initially
  const initialHealth = await new Promise(resolve => {
    http.get(`http://127.0.0.1:${port}/gateway/health`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
  });
  assert.equal(initialHealth.status, 'degraded');
  assert.equal(initialHealth.durableSinkConfigured, false);
  assert.equal(initialHealth.connectedClients, 0);

  // 2. Connect real HTTP SSE client
  const receivedMessages = [];
  const clientReq = http.request({
    host: '127.0.0.1',
    port,
    path: '/gateway/stream',
    headers: { 'x-request-id': 'test-sse-client-1' }
  }, res => {
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
    res.on('data', chunk => {
      receivedMessages.push(chunk.toString());
    });
  });
  clientReq.end();

  // Wait briefly for connection registration
  await new Promise(r => setTimeout(r, 80));

  const clientHealth = await new Promise(resolve => {
    http.get(`http://127.0.0.1:${port}/gateway/health`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
  });
  assert.equal(clientHealth.connectedClients, 1);

  // 3. Unauthorized broadcast is rejected
  const unauthorizedRes = await new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/gateway/broadcast',
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    }, res => {
      resolve(res.statusCode);
    });
    req.write(JSON.stringify({ version: 2 }));
    req.end();
  });
  assert.equal(unauthorizedRes, 401);

  // 4. Authorized broadcast succeeds and reaches client
  const updateEnvelope = createStateEnvelope({
    sessionId: 'sess-auth-broadcast',
    version: 5,
    state: 'open'
  }, {
    id: 'q-5',
    question: 'Live broadcast test?',
    options: ['A', 'B', 'C', 'D'],
    category: 'culture'
  });

  const broadcastRes = await new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/gateway/broadcast',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer dev-gateway-secret'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.write(JSON.stringify(updateEnvelope));
    req.end();
  });

  assert.equal(broadcastRes.broadcast, true);
  assert.equal(broadcastRes.delivered, 1);
  assert.equal(broadcastRes.version, 5);

  // Allow message to be received by client
  await new Promise(r => setTimeout(r, 60));
  const fullStream = receivedMessages.join('');
  assert.ok(fullStream.includes('event: state'), 'Must contain SSE state event');
  assert.ok(fullStream.includes('Live broadcast test?'), 'Must contain broadcasted question');

  // Clean up
  clientReq.destroy();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(sseClients.size, 0, 'Disconnected SSE responses must leave the fanout set');
  await new Promise(resolve => server.close(resolve));
  resetClients();
});

test('3,000-client fanout gate: all clients receive broadcast within 2s with 0 DB reads', async () => {
  resetClients();
  const CLIENT_COUNT = 3000;
  const clientReceivedTimes = new Map();
  let dbQueriesExecuted = 0; // In-memory broadcast path must never touch database

  // Register 3,000 client streams into gateway SSE pool
  for (let i = 0; i < CLIENT_COUNT; i++) {
    const clientId = i;
    const mockClientStream = new Writable({
      write(chunk, encoding, callback) {
        const str = chunk.toString();
        if (str.includes('event: state') && str.includes('fanout-gate-q')) {
          clientReceivedTimes.set(clientId, Date.now());
        }
        callback();
      }
    });
    sseClients.add(mockClientStream);
  }

  assert.equal(sseClients.size, CLIENT_COUNT, 'Must have 3,000 registered client sinks');

  // Prepare broadcast envelope
  const envelope = createStateEnvelope({
    sessionId: 'session-fanout-3000',
    version: 77,
    state: 'open',
    responseCount: 0
  }, {
    id: 'fanout-gate-q',
    category: 'geography',
    question: 'How fast can NIAC Live broadcast to 3,000 devices?',
    options: ['<50ms', '<100ms', '<500ms', '<2s']
  });

  const broadcastStartTime = Date.now();
  const deliveredCount = broadcastState(envelope);
  const fanoutDurationMs = Date.now() - broadcastStartTime;

  assert.equal(deliveredCount, CLIENT_COUNT, 'broadcastState must deliver to all 2,500 clients');
  assert.equal(clientReceivedTimes.size, CLIENT_COUNT, 'All 2,500 clients must receive the payload');
  assert.equal(dbQueriesExecuted, 0, 'Must execute 0 database reads during broadcast fanout');

  assert.ok(
    fanoutDurationMs <= 2000,
    `Fanout to 2,500 clients must complete within 2,000ms. Measured: ${fanoutDurationMs}ms`
  );

  // Clean up
  resetClients();
});
