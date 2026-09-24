import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  signParticipantCredential,
  verifyParticipantCredential
} from '../lib/credentials.mjs';
import { SQLiteAnswerQueue } from '../gateway/lib/sqlite-queue.mjs';
import { BatchFlusher } from '../gateway/lib/batch-flusher.mjs';
import { createGatewayServer, setCachedEnvelope } from '../gateway/server.mjs';
import { createStateEnvelope } from '../lib/state-envelope.mjs';

test('participant credentials: HMAC signing, verification, and tamper detection', () => {
  const secret = 'test-secret-key-1';
  const token = signParticipantCredential({
    participantId: 'p-12345',
    eventId: 'niac-2026',
    isRehearsal: false
  }, secret, 3600 * 1000);

  // 1. Valid token verifies
  const validRes = verifyParticipantCredential(token, secret);
  assert.equal(validRes.valid, true);
  assert.equal(validRes.payload.participantId, 'p-12345');
  assert.equal(validRes.payload.eventId, 'niac-2026');
  assert.equal(validRes.payload.isRehearsal, false);

  // 2. Tampered payload fails
  const [payloadB64, sigB64] = token.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({
    participantId: 'p-HACKER',
    eventId: 'niac-2026'
  })).toString('base64url');
  const tamperedToken = `${tamperedPayload}.${sigB64}`;

  const tamperedRes = verifyParticipantCredential(tamperedToken, secret);
  assert.equal(tamperedRes.valid, false);
  assert.equal(tamperedRes.error, 'INVALID_SIGNATURE');

  // 3. Tampered signature fails
  const badSigToken = `${payloadB64}.badSignature123`;
  const badSigRes = verifyParticipantCredential(badSigToken, secret);
  assert.equal(badSigRes.valid, false);
  assert.equal(badSigRes.error, 'INVALID_SIGNATURE');

  // 4. Expired credential fails
  const expiredToken = signParticipantCredential({
    participantId: 'p-old'
  }, secret, -1000); // already expired

  const expiredRes = verifyParticipantCredential(expiredToken, secret);
  assert.equal(expiredRes.valid, false);
  assert.equal(expiredRes.error, 'EXPIRED');
});

test('participant credentials: dual-key rotation allows previous key seamlessly', () => {
  const oldSecret = 'old-secret-key-2025';
  const newSecret = 'new-active-secret-2026';

  // Sign token with old secret
  const oldToken = signParticipantCredential({ participantId: 'p-migrating' }, oldSecret);

  // Verify with only new secret -> fails
  const failedRes = verifyParticipantCredential(oldToken, newSecret, null);
  assert.equal(failedRes.valid, false);

  // Verify with new secret and previousSecret fallback -> succeeds!
  const rotatedRes = verifyParticipantCredential(oldToken, newSecret, oldSecret);
  assert.equal(rotatedRes.valid, true);
  assert.equal(rotatedRes.payload.participantId, 'p-migrating');
});

test('participant credential secrets normalize surrounding deployment whitespace',()=>{
  const token=signParticipantCredential({participantId:'p-whitespace'},'  rotated-secret\r\n');
  assert.equal(verifyParticipantCredential(token,'rotated-secret').valid,true);
  assert.equal(verifyParticipantCredential(token,'different','\n rotated-secret \n').valid,true);
});

test('SQLite WAL queue: high-throughput group commits and atomic deduplication', async () => {
  const queue = new SQLiteAnswerQueue(':memory:', {
    groupCommitIntervalMs: 10,
    groupCommitBatchSize: 20
  });

  const TOTAL_ANSWERS = 200;
  const promises = [];

  const t0 = Date.now();
  for (let i = 0; i < TOTAL_ANSWERS; i++) {
    promises.push(queue.enqueueAnswer({
      participantId: `part-${i}`,
      sessionId: 'session-wal-1',
      questionId: 'q-test-1',
      optionIndex: i % 4,
      idempotencyKey: `idem-${i}`
    }));
  }

  const results = await Promise.all(promises);
  const durationMs = Date.now() - t0;

  assert.equal(results.length, TOTAL_ANSWERS);
  for (let i = 0; i < TOTAL_ANSWERS; i++) {
    assert.equal(results[i].accepted, true);
    assert.equal(results[i].duplicate, false);
    assert.ok(results[i].answerId);
  }

  assert.equal(queue.getQueueDepth(), TOTAL_ANSWERS);

  // Test deduplication on exact duplicate re-submission
  const dupResult = await queue.enqueueAnswer({
    participantId: 'part-0',
    sessionId: 'session-wal-1',
    questionId: 'q-test-1',
    optionIndex: 0,
    idempotencyKey: 'idem-0'
  });

  assert.equal(dupResult.accepted, true);
  assert.equal(dupResult.duplicate, true);
  assert.equal(dupResult.answerId, results[0].answerId);

  // Depth should remain unchanged
  assert.equal(queue.getQueueDepth(), TOTAL_ANSWERS);

  queue.close();
});

test('gateway answer ingress: rejects unauth, validates question barriers and enqueues', async () => {
  const queue = new SQLiteAnswerQueue(':memory:');
  const server = createGatewayServer(queue);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const validToken = signParticipantCredential({ participantId: 'player-alpha' });

  // 1. Unauthenticated request rejected
  const unauthRes = await new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/gateway/answers',
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    }, res => resolve(res.statusCode));
    req.write(JSON.stringify({ questionId: 'q-active', optionIndex: 1, idempotencyKey: '00000000-0000-4000-8000-000000000001' }));
    req.end();
  });
  assert.equal(unauthRes, 401);

  // 2. Question not open rejected (currently lobby)
  setCachedEnvelope(createStateEnvelope({ state: 'lobby', version: 1 }));
  const notOpenRes = await new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/gateway/answers',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${validToken}`
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.write(JSON.stringify({ questionId: 'q-active', optionIndex: 1, idempotencyKey: '00000000-0000-4000-8000-000000000001' }));
    req.end();
  });
  assert.equal(notOpenRes.status, 409);
  assert.equal(notOpenRes.body.code, 'QUESTION_NOT_OPEN');

  // 3. Question open: answer accepted and acknowledged
  setCachedEnvelope(createStateEnvelope({
    state: 'open',
    sessionId: 'sess-open-1',
    deadlineAt: new Date(Date.now() + 15000).toISOString(),
    version: 2
  }, {
    id: 'q-active',
    question: 'Active question?',
    options: ['A', 'B', 'C', 'D'],
    category: 'culture'
  }));

  const acceptedRes = await new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/gateway/answers',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${validToken}`
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.write(JSON.stringify({ questionId: 'q-active', optionIndex: 2, idempotencyKey: '00000000-0000-4000-8000-000000000002' }));
    req.end();
  });

  assert.equal(acceptedRes.status, 200);
  assert.equal(acceptedRes.body.accepted, true);
  assert.equal(acceptedRes.body.duplicate, false);
  assert.ok(acceptedRes.body.answerId);

  // 4. Duplicate submission returns duplicate flag
  const duplicateRes = await new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/gateway/answers',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${validToken}`
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.write(JSON.stringify({ questionId: 'q-active', optionIndex: 2, idempotencyKey: '00000000-0000-4000-8000-000000000002' }));
    req.end();
  });

  assert.equal(duplicateRes.status, 200);
  assert.equal(duplicateRes.body.accepted, true);
  assert.equal(duplicateRes.body.duplicate, true);
  assert.equal(duplicateRes.body.answerId, acceptedRes.body.answerId);

  // 5. Late answer after deadline rejected
  setCachedEnvelope(createStateEnvelope({
    state: 'open',
    sessionId: 'sess-open-1',
    deadlineAt: new Date(Date.now() - 5000).toISOString(), // expired
    version: 3
  }, {
    id: 'q-active',
    question: 'Active question?',
    options: ['A', 'B', 'C', 'D']
  }));

  const lateToken = signParticipantCredential({ participantId: 'player-late' });
  const lateRes = await new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/gateway/answers',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${lateToken}`
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.write(JSON.stringify({ questionId: 'q-active', optionIndex: 0, idempotencyKey: '00000000-0000-4000-8000-000000000003' }));
    req.end();
  });

  assert.equal(lateRes.status, 409);
  assert.equal(lateRes.body.code, 'ANSWER_LATE');

  await new Promise(resolve => server.close(resolve));
  queue.close();
});

test('batch flusher: drains SQLite queue to sink and satisfies barrier contract', async () => {
  const queue = new SQLiteAnswerQueue(':memory:');
  const flushedItems = [];

  const flusher = new BatchFlusher(queue, {
    flushIntervalMs: 20,
    batchSize: 50,
    sink: async items => {
      flushedItems.push(...items);
    }
  });

  // Enqueue 75 answers
  for (let i = 0; i < 75; i++) {
    await queue.enqueueAnswer({
      participantId: `drain-user-${i}`,
      sessionId: 'sess-drain',
      questionId: 'q-drain',
      optionIndex: i % 4,
      idempotencyKey: `drain-key-${i}`
    });
  }

  assert.equal(queue.getQueueDepth(), 75);

  // Drain queue
  await flusher.drainQueue(2000);

  assert.equal(queue.getQueueDepth(), 0, 'Queue depth must reach 0 after drain');
  assert.equal(flushedItems.length, 75, 'All 75 items must have reached the sink');

  queue.close();
});

test('crash recovery acceptance gate: zero answers lost across simulated process restart', async () => {
  const testDbFile = path.resolve(process.cwd(), 'data', `test-crash-recovery-${Date.now()}.db`);

  // Step 1: Initial gateway instance starts and enqueues 500 answers into SQLite WAL queue
  let queue1 = new SQLiteAnswerQueue(testDbFile, {
    groupCommitIntervalMs: 10,
    groupCommitBatchSize: 25
  });

  const COUNT = 500;
  const enqueuedIds = [];

  for (let i = 0; i < COUNT; i++) {
    const res = await queue1.enqueueAnswer({
      participantId: `crash-player-${i}`,
      sessionId: 'session-crash-test',
      questionId: 'q-crash-1',
      optionIndex: i % 4,
      idempotencyKey: `crash-idem-${i}`
    });
    enqueuedIds.push(res.answerId);
  }

  assert.equal(queue1.getQueueDepth(), COUNT);
  assert.equal(enqueuedIds.length, COUNT);

  // Step 2: Simulate unhandled process crash / abrupt shutdown
  // Force flush pending memory buffer and close SQLite connection without draining
  queue1.close();
  queue1 = null;

  // Step 3: Gateway process restarts. Opens new SQLite queue on same disk database.
  const queue2 = new SQLiteAnswerQueue(testDbFile);

  // Step 4: Verify ZERO answers lost upon restart
  const recoveredDepth = queue2.getQueueDepth();
  assert.equal(
    recoveredDepth,
    COUNT,
    `Zero answers must be lost across crash/restart. Expected ${COUNT}, found ${recoveredDepth}`
  );

  // Step 5: Resume flusher and verify clean drain to persistent sink
  const sinkSinkedAnswers = [];
  const flusher = new BatchFlusher(queue2, {
    batchSize: 100,
    sink: async items => {
      sinkSinkedAnswers.push(...items);
    }
  });

  await flusher.drainQueue(3000);

  assert.equal(queue2.getQueueDepth(), 0, 'Recovered queue must drain completely');
  assert.equal(sinkSinkedAnswers.length, COUNT, 'All 500 recovered answers successfully flushed');

  queue2.close();

  // Clean up disk test file
  try {
    if (fs.existsSync(testDbFile)) fs.unlinkSync(testDbFile);
    const walFile = `${testDbFile}-wal`;
    const shmFile = `${testDbFile}-shm`;
    if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
    if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);
  } catch {}
});
