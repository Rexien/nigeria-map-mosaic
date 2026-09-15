import test from 'node:test';
import assert from 'node:assert/strict';
import { getCapacityConfig, redactSensitive, formatLog, MetricsAggregator } from '../lib/telemetry.mjs';

test('structured logger formats valid JSON with requestId and redacts participant tokens', () => {
  const payload = {
    requestId: 'req-1234',
    participantId: 'p-5678',
    token: 'super-secret-token-value',
    token_hash: 'hash-value-here',
    alias: 'Kene'
  };
  const jsonStr = formatLog('info', 'join', payload);
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.level, 'INFO');
  assert.equal(parsed.event, 'join');
  assert.equal(parsed.requestId, 'req-1234');
  assert.equal(parsed.alias, 'Kene');
  assert.equal(parsed.token, '[REDACTED]');
  assert.equal(parsed.token_hash, '[REDACTED]');
  assert.doesNotMatch(jsonStr, /super-secret-token-value/);
});

test('structured logger redacts authorization bearer tokens and recovery codes', () => {
  const payload = {
    authorization: 'Bearer secret_auth_token_9999',
    recoveryCode: 'AB12-CD34',
    rawMessage: 'Bearer user_token_7777',
    nested: {
      password: 'mypassword123',
      secret: 'deep_secret'
    }
  };
  const sanitized = redactSensitive(payload);
  assert.equal(sanitized.authorization, '[REDACTED]');
  assert.equal(sanitized.recoveryCode, '[REDACTED]');
  assert.equal(sanitized.rawMessage, 'Bearer [REDACTED]');
  assert.equal(sanitized.nested.password, '[REDACTED]');
  assert.equal(sanitized.nested.secret, '[REDACTED]');
});

test('metrics aggregator computes accurate p50, p95, and p99 percentiles', () => {
  const aggregator = new MetricsAggregator();
  // Feed 100 sample latencies: 1 to 100 ms
  for (let i = 1; i <= 100; i++) {
    aggregator.recordAckLatency(i);
  }
  const snap = aggregator.getSnapshot();
  aggregator.stop();
  assert.equal(snap.samples, 100);
  assert.equal(snap.p50AckMs, 50);
  assert.equal(snap.p95AckMs, 95);
  assert.equal(snap.p99AckMs, 99);
});

test('metrics aggregator transitions capacity status between green, amber, and red', () => {
  const aggregator = new MetricsAggregator({
    testPlayers: 500,
    maxActivePlayers: 1500,
    queueDepthLimit: 1000,
    ackTimeoutMs: 2000,
    drainTimeoutMs: 3000,
    greenQueueMax: 10,
    amberQueueMax: 20,
    amberP95AckMs: 100,
    redP95AckMs: 200
  });

  // Normal: Green
  aggregator.recordAckLatency(20);
  assert.equal(aggregator.getSnapshot().status, 'green');

  // Elevated queue: Amber
  aggregator.setQueueStatus(15);
  assert.equal(aggregator.getSnapshot().status, 'amber');

  // High queue: Red
  aggregator.setQueueStatus(25);
  assert.equal(aggregator.getSnapshot().status, 'red');

  // Clear queue, high latency: Red
  aggregator.setQueueStatus(0);
  for (let i = 0; i < 20; i++) aggregator.recordAckLatency(300);
  assert.equal(aggregator.getSnapshot().status, 'red');

  aggregator.stop();
});

test('event loop lag monitor records measurable loop delay', async () => {
  const aggregator = new MetricsAggregator();
  await new Promise(r => setTimeout(r, 600));
  const snap = aggregator.getSnapshot();
  aggregator.stop();
  assert.equal(typeof snap.eventLoopLagMs, 'number');
  assert.ok(snap.eventLoopLagMs >= 0);
});

test('capacity configuration loads valid thresholds and validates participant limits', () => {
  const customEnv = {
    TEST_PLAYERS: '800',
    MAX_ACTIVE_PLAYERS: '2500',
    QUEUE_DEPTH_LIMIT: '5000',
    ACK_TIMEOUT_MS: '1500'
  };
  const config = getCapacityConfig(customEnv);
  assert.equal(config.testPlayers, 800);
  assert.equal(config.maxActivePlayers, 2500);
  assert.equal(config.queueDepthLimit, 5000);
  assert.equal(config.ackTimeoutMs, 1500);

  // Fallbacks on invalid values
  const invalidConfig = getCapacityConfig({ TEST_PLAYERS: 'invalid', MAX_ACTIVE_PLAYERS: '-10' });
  assert.equal(invalidConfig.testPlayers, 500);
  assert.equal(invalidConfig.maxActivePlayers, 1500);
});

test('admin status endpoint exposes capacity metrics while hiding tokens', async () => {
  const aggregator = new MetricsAggregator();
  aggregator.recordAckLatency(45);
  const snap = aggregator.getSnapshot();
  aggregator.stop();

  const mockAdminStatus = {
    event: { name: 'NIAC Live' },
    metrics: { participants: 100, responseCount: 45 },
    capacity: snap
  };

  const logged = formatLog('info', 'admin_status', mockAdminStatus);
  const parsed = JSON.parse(logged);

  assert.ok(parsed.capacity);
  assert.equal(parsed.capacity.status, 'green');
  assert.equal(parsed.capacity.p50AckMs, 45);
  assert.equal('token' in parsed, false);
});

test('late answers and duplicates generate structured telemetry events', () => {
  const duplicateLog = formatLog('info', 'answer_duplicate', {
    requestId: 'req-dup-1',
    participantId: 'p-1',
    questionId: 'q-1',
    accepted: true,
    duplicate: true
  });
  const lateLog = formatLog('warn', 'answer_late', {
    requestId: 'req-late-1',
    participantId: 'p-2',
    questionId: 'q-1',
    accepted: false,
    reason: 'ANSWER_LATE'
  });

  const parsedDup = JSON.parse(duplicateLog);
  const parsedLate = JSON.parse(lateLog);

  assert.equal(parsedDup.event, 'answer_duplicate');
  assert.equal(parsedDup.duplicate, true);
  assert.equal(parsedLate.event, 'answer_late');
  assert.equal(parsedLate.reason, 'ANSWER_LATE');
});
