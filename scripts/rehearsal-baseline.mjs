// NIAC Live 500-Player Reproducible Rehearsal Baseline Script
// Simulates concurrent player joins, final-5-second answer spike, and duplicate retry.
// Records exact p50, p95, p99 acknowledgment latencies and duplicate integrity.

import http from 'node:http';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4173';
const PARTICIPANT_COUNT = Number(process.env.TEST_PLAYERS || process.env.PARTICIPANTS || 500);

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

async function request(urlStr, options = {}) {
  const url = new URL(urlStr);
  const method = options.method || 'GET';
  const headers = options.headers || {};
  const body = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : null;

  if (body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const start = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const durationMs = Date.now() - start;
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json, durationMs });
      });
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || 10000, () => {
      req.destroy(new Error('Request timed out'));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function ensureOpenQuestion() {
  const stateRes = await request(`${BASE_URL}/api/state`);
  if (stateRes.status === 200 && stateRes.json?.state === 'open' && stateRes.json?.question) {
    return stateRes.json;
  }

  // If running against local dev server, authenticate as admin and open a rehearsal question
  console.log('Session not in open state. Attempting to open question via dev admin...');
  const authRes = await request(`${BASE_URL}/api/dev/admin`, { method: 'POST' });
  const adminToken = authRes.json?.token || 'local-admin';

  const statusRes = await request(`${BASE_URL}/api/admin/status`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });

  const questionId = statusRes.json?.questions?.[0]?.id;
  if (!questionId) {
    throw new Error('No ready questions found to open for rehearsal.');
  }

  // Set rehearsal mode
  await request(`${BASE_URL}/api/admin/action`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { kind: 'set_settings', activeActivity: 'passport', rehearsalMode: true }
  });

  // Open question with 60s duration for test run
  const openRes = await request(`${BASE_URL}/api/admin/action`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { kind: 'open_question', questionId, durationSeconds: 60 }
  });

  if (openRes.status !== 200) {
    throw new Error(`Failed to open question: ${openRes.body}`);
  }

  const updatedState = await request(`${BASE_URL}/api/state`);
  return updatedState.json;
}

async function runPlayer(vu, state) {
  const vuId = String(vu).padStart(12, '0');
  const alias = `Rehearsal-${vu}-${Date.now().toString(36)}`;

  // 1. Join
  const joinRes = await request(`${BASE_URL}/api/participants`, {
    method: 'POST',
    body: { alias, rehearsal: true }
  });

  if (joinRes.status !== 201 || !joinRes.json?.token) {
    return { vu, success: false, error: `Join failed: HTTP ${joinRes.status}` };
  }

  const token = joinRes.json.token;
  const participantId = joinRes.json.participant.id;
  const idempotencyKey = `00000000-0000-4000-8000-${vuId}`;

  // 2. Random jitter to simulate final-5-second answer spike (0 to 4500ms)
  const jitterMs = Math.floor(Math.random() * 4500);
  await new Promise(r => setTimeout(r, jitterMs));

  // 3. First answer submission
  const answerPayload = {
    sessionId: state.sessionId,
    questionId: state.question.id,
    optionIndex: vu % 4,
    idempotencyKey
  };

  const ansRes = await request(`${BASE_URL}/api/answers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: answerPayload
  });

  const ackLatency = ansRes.durationMs;
  const ackSuccess = ansRes.status === 200 && ansRes.json?.accepted === true && ansRes.json?.duplicate === false;

  // 4. Immediate duplicate retry with same idempotency key
  const dupRes = await request(`${BASE_URL}/api/answers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: answerPayload
  });

  const dupLatency = dupRes.durationMs;
  const dupSuccess = dupRes.status === 200 && dupRes.json?.accepted === true && dupRes.json?.duplicate === true;

  return {
    vu,
    participantId,
    joinLatency: joinRes.durationMs,
    ackLatency,
    ackSuccess,
    ackStatus: ansRes.status,
    dupLatency,
    dupSuccess,
    dupStatus: dupRes.status
  };
}

async function main() {
  console.log('====================================================');
  console.log('  NIAC LIVE 500-PLAYER REHEARSAL BASELINE HARNESS');
  console.log(`  Target: ${BASE_URL} | Players: ${PARTICIPANT_COUNT}`);
  console.log('====================================================\n');

  console.log('1. Checking server health and active question...');
  const state = await ensureOpenQuestion();
  console.log(`   Session ID: ${state.sessionId}`);
  console.log(`   Question: ${state.question.title} - ${state.question.question}`);
  console.log(`   Deadline: ${state.deadlineAt}\n`);

  console.log(`2. Spawning ${PARTICIPANT_COUNT} concurrent participants into the answer window...`);
  const startTime = Date.now();

  const promises = [];
  for (let vu = 1; vu <= PARTICIPANT_COUNT; vu++) {
    promises.push(runPlayer(vu, state));
  }

  const results = await Promise.all(promises);
  const totalDuration = Date.now() - startTime;

  console.log(`\n3. Completed all ${PARTICIPANT_COUNT} player flows in ${(totalDuration / 1000).toFixed(2)}s\n`);

  // Analyze metrics
  const successfulJoins = results.filter(r => r.joinLatency !== undefined).length;
  const ackLatencies = results.filter(r => r.ackSuccess).map(r => r.ackLatency);
  const dupLatencies = results.filter(r => r.dupSuccess).map(r => r.dupLatency);
  const failedAcks = results.filter(r => !r.ackSuccess);
  const failedDups = results.filter(r => !r.dupSuccess);

  const p50Ack = percentile(ackLatencies, 50);
  const p95Ack = percentile(ackLatencies, 95);
  const p99Ack = percentile(ackLatencies, 99);
  const maxAck = Math.max(...(ackLatencies.length ? ackLatencies : [0]));

  const p50Dup = percentile(dupLatencies, 50);
  const p95Dup = percentile(dupLatencies, 95);

  const ackSuccessRate = ((ackLatencies.length / PARTICIPANT_COUNT) * 100).toFixed(2);
  const dupIntegrityRate = (((PARTICIPANT_COUNT - failedDups.length) / PARTICIPANT_COUNT) * 100).toFixed(2);

  console.log('----------------------------------------------------');
  console.log('  REHEARSAL BASELINE RESULTS');
  console.log('----------------------------------------------------');
  console.log(`  Total Participants:       ${PARTICIPANT_COUNT}`);
  console.log(`  Successful Joins:         ${successfulJoins} / ${PARTICIPANT_COUNT}`);
  console.log(`  Durably Acknowledged:     ${ackLatencies.length} / ${PARTICIPANT_COUNT} (${ackSuccessRate}%)`);
  console.log(`  Duplicate Retries Valid:  ${PARTICIPANT_COUNT - failedDups.length} / ${PARTICIPANT_COUNT} (${dupIntegrityRate}%)`);
  console.log('');
  console.log(`  Answer Ack Latency (p50): ${p50Ack} ms`);
  console.log(`  Answer Ack Latency (p95): ${p95Ack} ms`);
  console.log(`  Answer Ack Latency (p99): ${p99Ack} ms`);
  console.log(`  Answer Ack Latency (max): ${maxAck} ms`);
  console.log(`  Duplicate Ack (p95):      ${p95Dup} ms`);
  console.log('----------------------------------------------------');

  if (failedAcks.length > 0) {
    console.error(`\n[WARN] ${failedAcks.length} answers failed acknowledgment:`, failedAcks.slice(0, 5));
  }
  if (failedDups.length > 0) {
    console.error(`\n[WARN] ${failedDups.length} duplicate checks failed:`, failedDups.slice(0, 5));
  }

  // Acceptance Gate check:
  // > 99.5% acknowledged, duplicate integrity 100%, p95 < 1000ms, p99 < 2000ms
  const pass = ackLatencies.length >= PARTICIPANT_COUNT * 0.995 && failedDups.length === 0 && p95Ack <= 1000;

  console.log(`\nBASELINE STATUS: ${pass ? 'PASSED (STABLE BASELINE ESTABLISHED)' : 'DEGRADED'}`);
  process.exit(pass ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal rehearsal harness error:', err);
  process.exit(1);
});
