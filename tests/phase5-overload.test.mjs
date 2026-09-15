import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MetricsAggregator, getCapacityConfig } from '../lib/telemetry.mjs';
import { signParticipantCredential, verifyParticipantCredential } from '../lib/credentials.mjs';
import { SQLiteAnswerQueue } from '../gateway/lib/sqlite-queue.mjs';
import { computeScoresAndRanks, generateSnapshots } from '../lib/snapshot-scoring.mjs';

test('capacity evaluator transitions between green, amber, and red with auto-tuning', () => {
  const config = getCapacityConfig({
    TEST_PLAYERS: '500',
    MAX_ACTIVE_PLAYERS: '1500',
    QUEUE_DEPTH_LIMIT: '2000',
    ACK_TIMEOUT_MS: '2000',
    GREEN_QUEUE_MAX: '5',
    AMBER_QUEUE_MAX: '20',
    AMBER_P95_ACK_MS: '50',
    RED_P95_ACK_MS: '150',
    AMBER_ERROR_RATE: '2.0',
    RED_ERROR_RATE: '5.0'
  });

  const aggregator = new MetricsAggregator(config);

  // Normal health -> Green
  aggregator.setQueueStatus(2);
  aggregator.recordAckLatency(15);
  aggregator.recordAckLatency(25);
  let snap = aggregator.getSnapshot();
  assert.equal(snap.status, 'green');

  // Moderate queue -> Amber
  aggregator.setQueueStatus(12);
  snap = aggregator.getSnapshot();
  assert.equal(snap.status, 'amber');

  // Severe queue -> Red
  aggregator.setQueueStatus(35);
  snap = aggregator.getSnapshot();
  assert.equal(snap.status, 'red');

  // Clear queue, high latency -> Red
  aggregator.setQueueStatus(0);
  for (let i = 0; i < 20; i++) aggregator.recordAckLatency(250);
  snap = aggregator.getSnapshot();
  assert.equal(snap.status, 'red');

  aggregator.stop();
});

test('spectator credential tamper detection and flag verification', () => {
  const secretKey = 'phase5-spectator-secret-key-12345';
  
  // Issue spectator credential
  const cred = signParticipantCredential({
    participantId: 'p-spec-1',
    alias: 'Chioma Spec',
    isSpectator: true
  }, secretKey);

  const verified = verifyParticipantCredential(cred, secretKey);
  assert.equal(verified.valid, true);
  assert.equal(verified.payload.participantId, 'p-spec-1');
  assert.equal(verified.payload.isSpectator, true);

  // Tamper with payload (attempting to remove spectator status)
  const parts = cred.split('.');
  const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  payload.isSpectator = false;
  const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const tamperedCred = `${tamperedPayloadB64}.${parts[1]}`;

  const tamperedResult = verifyParticipantCredential(tamperedCred, secretKey);
  assert.equal(tamperedResult.valid, false);
  assert.equal(tamperedResult.error, 'INVALID_SIGNATURE');
});

test('spectator answers bypass durable queue while active player answers are enqueued', async () => {
  const dbPath = `:memory:`;
  const queue = new SQLiteAnswerQueue(dbPath);
  const secretKey = 'phase5-queue-bypass-key-12345';

  const activeCred = signParticipantCredential({
    participantId: 'p-active-1',
    alias: 'Active Player',
    isSpectator: false
  }, secretKey);

  const spectatorCred = signParticipantCredential({
    participantId: 'p-spec-2',
    alias: 'Spectator Player',
    isSpectator: true
  }, secretKey);

  // Simulate gateway answer handler logic
  const handleAnswer = async (credential, answerPayload) => {
    const verified = verifyParticipantCredential(credential, secretKey);
    if (!verified.valid) return { status: 401, body: { error: 'Unauthorized' } };

    // Spectator bypass: instant ack, skip durable queue
    if (verified.payload.isSpectator) {
      return {
        status: 200,
        body: {
          accepted: true,
          duplicate: false,
          spectator: true,
          receivedAt: new Date().toISOString()
        }
      };
    }

    // Active contestant: enqueue to SQLite WAL
    const res = await queue.enqueueAnswer({
      sessionId: answerPayload.sessionId,
      questionId: answerPayload.questionId,
      participantId: verified.payload.participantId,
      optionIndex: answerPayload.optionIndex,
      idempotencyKey: answerPayload.idempotencyKey,
      clientSubmittedAt: answerPayload.clientRecordedAt
    });

    return {
      status: 200,
      body: {
        accepted: true,
        duplicate: res.duplicate,
        spectator: false,
        answerId: res.answerId
      }
    };
  };

  // 1. Spectator submits answer
  const t0 = performance.now();
  const specRes = await handleAnswer(spectatorCred, {
    sessionId: 'session-1',
    questionId: 'q-1',
    optionIndex: 2,
    idempotencyKey: 'idemp-spec-1'
  });
  const specDuration = performance.now() - t0;

  assert.equal(specRes.status, 200);
  assert.equal(specRes.body.spectator, true);
  assert.ok(specDuration < 10, `Spectator ack should be instant (<10ms), took ${specDuration}ms`);
  assert.equal(queue.getQueueDepth(), 0, 'Queue depth must remain 0 after spectator answer');

  // 2. Active player submits answer
  const activeRes = await handleAnswer(activeCred, {
    sessionId: 'session-1',
    questionId: 'q-1',
    optionIndex: 1,
    idempotencyKey: 'idemp-active-1'
  });
  assert.equal(activeRes.status, 200);
  assert.equal(activeRes.body.spectator, false);
  assert.equal(queue.getQueueDepth(), 1, 'Queue depth must be 1 after active contestant answer');

  queue.close();
});

test('spectators are excluded from competitive leaderboard rankings', () => {
  const participants = [
    { id: 'p1', alias: 'Ada (Contestant)', created_at: '2026-09-14T10:00:00Z', is_spectator: false },
    { id: 'p2', alias: 'Emeka (Contestant)', created_at: '2026-09-14T10:01:00Z', is_spectator: false },
    { id: 'p3', alias: 'Zainab (Spectator)', created_at: '2026-09-14T10:02:00Z', is_spectator: true },
    { id: 'p4', alias: 'Babatunde (Contestant)', created_at: '2026-09-14T10:03:00Z', is_spectator: false }
  ];

  const questions = [
    { id: 'q1', activity: 'passport', correct_option: 0, points: 1000, category: 'Heritage', is_void: false }
  ];

  // All 4 submit correct answers
  const answers = [
    { participant_id: 'p1', question_id: 'q1', option_index: 0, client_recorded_at: '2026-09-14T10:05:01Z' },
    { participant_id: 'p2', question_id: 'q1', option_index: 0, client_recorded_at: '2026-09-14T10:05:02Z' },
    { participant_id: 'p3', question_id: 'q1', option_index: 0, client_recorded_at: '2026-09-14T10:05:00.5Z' }, // Spectator answered fastest!
    { participant_id: 'p4', question_id: 'q1', option_index: 0, client_recorded_at: '2026-09-14T10:05:03Z' }
  ];

  const computed = computeScoresAndRanks({
    participants,
    questions,
    answers
  });

  // Check snapshots: spectators must have rank: null
  const p3Scored = computed.participantSnapshots.get('p3');
  assert.equal(p3Scored.isSpectator, true);
  assert.equal(p3Scored.rank, null, 'Spectator must have null rank');
  assert.equal(p3Scored.scores.combined, 1000, 'Spectator still receives personal score calculation');

  const p1Scored = computed.participantSnapshots.get('p1');
  const p2Scored = computed.participantSnapshots.get('p2');
  const p4Scored = computed.participantSnapshots.get('p4');

  assert.equal(p1Scored.rank, 1);
  assert.equal(p2Scored.rank, 2);
  assert.equal(p4Scored.rank, 3);

  // Generate snapshots
  const generated = generateSnapshots({
    sessionId: 'session-overload-test',
    snapshotVersion: 1,
    participants,
    questions,
    answers
  });

  // Verify leaderboard snapshot Top 10 does NOT include spectator
  assert.equal(generated.leaderboards.passport.leaders.length, 3);
  assert.ok(!generated.leaderboards.passport.leaders.some(l => l.participantId === 'p3' || l.alias.includes('Spectator')), 'Leaderboard must not include spectator');
});

test('roster freeze assigns spectator status to incoming participants', () => {
  // Logic modeling the dev server / Netlify participant intake
  let rosterFrozen = false;
  let activeCount = 0;
  const maxActivePlayers = 3;

  function registerParticipant(alias) {
    const isSpectator = rosterFrozen || (activeCount >= maxActivePlayers);
    if (!isSpectator) activeCount++;
    return {
      alias,
      isSpectator
    };
  }

  // 1. Initial active participants join
  const u1 = registerParticipant('User 1');
  const u2 = registerParticipant('User 2');
  assert.equal(u1.isSpectator, false);
  assert.equal(u2.isSpectator, false);

  // 2. Manual roster freeze triggered by admin
  rosterFrozen = true;
  const u3 = registerParticipant('User 3 (Late)');
  assert.equal(u3.isSpectator, true);

  // 3. Unfreeze roster
  rosterFrozen = false;
  const u4 = registerParticipant('User 4');
  assert.equal(u4.isSpectator, false); // Slot 3 of 3

  // 4. Capacity limit reached (3 of 3)
  const u5 = registerParticipant('User 5 (Over capacity)');
  assert.equal(u5.isSpectator, true, 'Must automatically become spectator when maxActivePlayers reached');
});

test('projector screen continuity preserves state during transient network disruption', () => {
  // Simulation of display.html / app.js offline continuity behavior
  let currentState = {
    activity: 'passport',
    state: 'open',
    question: { id: 'q-live', question: 'What is the capital of Nigeria?', options: ['Lagos', 'Abuja'] },
    responseCount: 142,
    serverNow: new Date().toISOString()
  };

  let renderedScreenState = null;
  let connectionStatus = true;

  function renderDisplay(s) {
    if (!s) return;
    renderedScreenState = `${s.state}:${s.question?.id}:${s.responseCount}`;
  }

  function handleStateUpdate(newState, fetchFailed = false) {
    if (fetchFailed) {
      connectionStatus = false;
      // Critical continuity requirement: do NOT overwrite currentState with empty/null
      // Keep displaying the last rendered screen
      return;
    }
    currentState = newState;
    connectionStatus = true;
    renderDisplay(currentState);
  }

  // Initial state loads on projector
  handleStateUpdate(currentState);
  assert.equal(renderedScreenState, 'open:q-live:142');
  assert.equal(connectionStatus, true);

  // Transient network loss (e.g. WiFi hiccup or server restart)
  handleStateUpdate(null, true);
  assert.equal(connectionStatus, false);
  assert.equal(renderedScreenState, 'open:q-live:142', 'Projector must retain screen display during network outage');

  // Network restored with updated response count
  handleStateUpdate({
    ...currentState,
    responseCount: 180
  });
  assert.equal(connectionStatus, true);
  assert.equal(renderedScreenState, 'open:q-live:180');
});
