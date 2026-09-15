// NIAC Live Multi-Tier Rehearsal Ladder (Phase 6)
// Simulates live participant loads across four operational tiers:
// Tier 1: 100 players (Pre-event check)
// Tier 2: 500 players (Calibrated rehearsal baseline)
// Tier 3: 1,000 players (Expected live attendance)
// Tier 4: 2,500 players (Unknown surge / stress ceiling)

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom Telemetry Metrics
const ackLatency = new Trend('answer_ack_latency_ms');
const droppedAnswers = new Counter('dropped_answers_total');
const duplicateSuccess = new Counter('duplicate_acks_total');
const snapshotLookupLatency = new Trend('snapshot_lookup_latency_ms');
const errorRate = new Rate('request_errors');

const TIER = __ENV.TIER || '1000';
const TIERS = {
  '100': { vus: 100, duration: '60s' },
  '500': { vus: 500, duration: '90s' },
  '1000': { vus: 1000, duration: '120s' },
  '2500': { vus: 2500, duration: '180s' },
  '3000': { vus: 3000, duration: '180s' }
};

const selectedTier = TIERS[TIER] || TIERS['1000'];

export const options = {
  scenarios: {
    rehearsal_ladder: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: Math.floor(selectedTier.vus * 0.5) }, // Fast ramp-in (doors open)
        { duration: '30s', target: selectedTier.vus },                     // Full room seated
        { duration: '30s', target: selectedTier.vus },                     // Question open & answer spike
        { duration: '15s', target: 0 }                                     // Question reveal & wind-down
      ]
    }
  },
  thresholds: {
    answer_ack_latency_ms: ['p(95)<500', 'p(99)<1500'],
    snapshot_lookup_latency_ms: ['p(95)<50', 'p(99)<100'],
    request_errors: ['rate<0.01'],
    dropped_answers_total: ['count==0']
  }
};

export default function () {
  const base = __ENV.BASE_URL || 'http://127.0.0.1:4173';
  const gateway = __ENV.GATEWAY_URL || null;

  // Step 1: Join / Register
  const alias = `Contestant_${__VU}_${Date.now() % 100000}`;
  const joinRes = http.post(
    `${base}/api/participants`,
    JSON.stringify({ alias, rehearsal: true }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  const joinSuccess = check(joinRes, { 'join 200 or 201': r => r.status === 200 || r.status === 201 });
  if (!joinSuccess) {
    errorRate.add(1);
    return;
  }

  const identity = joinRes.json();
  const token = identity.credential || identity.token;

  // Step 2: Receive Active State
  const stateUrl = gateway ? `${gateway}/gateway/state` : `${base}/api/state`;
  const stateRes = http.get(stateUrl);
  if (stateRes.status !== 200) {
    errorRate.add(1);
    return;
  }

  const state = stateRes.json();
  if (state.state !== 'open' || !state.question) {
    sleep(1);
    return;
  }

  // Step 3: Simulate realistic human thinking delay (2 to 8 seconds)
  sleep(Math.random() * 6 + 2);

  // Step 4: Submit Answer during final seconds spike
  const answerUrl = gateway ? `${gateway}/gateway/answers` : `${base}/api/answers`;
  const idempotencyKey = `00000000-0000-4000-8000-${String(__VU).padStart(6,'0')}${String(__ITER % 1000000).padStart(6,'0')}`;
  const answerPayload = JSON.stringify({
    sessionId: state.sessionId,
    questionId: state.question.id,
    optionIndex: Math.floor(Math.random() * 4),
    idempotencyKey,
    clientSubmittedAt: new Date().toISOString()
  });

  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  const t0 = Date.now();
  const answerRes = http.post(answerUrl, answerPayload, { headers: authHeaders });
  const duration = Date.now() - t0;
  ackLatency.add(duration);

  const answerOk = check(answerRes, {
    'answer accepted or duplicate': r => r.status === 200 || (r.status === 409 && r.json().code === 'ANSWER_LATE')
  });

  if (!answerOk) {
    droppedAnswers.add(1);
    errorRate.add(1);
  } else if (answerRes.status === 200) {
    const resBody = answerRes.json();
    if (resBody.duplicate) duplicateSuccess.add(1);
  }

  // Step 5: Fast duplicate retry simulation
  if (Math.random() < 0.15) {
    const retryRes = http.post(answerUrl, answerPayload, { headers: authHeaders });
    check(retryRes, { 'duplicate acknowledged 200': r => r.status === 200 });
  }

  // Step 6: Post-Reveal Snapshot Read (O(1) personal score lookup)
  sleep(2);
  const meT0 = Date.now();
  const meRes = http.get(`${base}/api/me`, { headers: { Authorization: `Bearer ${identity.token}` } });
  snapshotLookupLatency.add(Date.now() - meT0);

  check(meRes, {
    'me snapshot 200': r => r.status === 200,
    'me returns scores': r => r.status === 200 && r.json().scores !== undefined
  });
}
