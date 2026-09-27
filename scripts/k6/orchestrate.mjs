// scripts/k6/orchestrate.mjs
// Independent 750-player k6 load runner against codex/load-reliability preview and gateway.
// Strictly isolated rehearsal participants, full metric capture, durability verification, and side-by-side comparison.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');

// Load environment variables from .env
function loadDotEnv() {
  const envPath = path.join(rootDir, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim();
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
}
loadDotEnv();

const cliArgs = process.argv.slice(2);
const getArg = (flag, def) => {
  const idx = cliArgs.indexOf(flag);
  return idx !== -1 && cliArgs[idx + 1] ? cliArgs[idx + 1] : def;
};

const BASE_URL = (getArg('--base-url') || process.env.NIAC_BASE_URL || 'https://niaclive.vercel.app').replace(/\/$/, '');
const GATEWAY_URL = (getArg('--gateway-url') || process.env.NIAC_GATEWAY_URL || 'https://92.4.146.91.sslip.io').replace(/\/$/, '');
const ADMIN_PIN = process.env.ADMIN_PIN || '19601960';
const BYPASS_SECRET = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || 'ZeNZGMB1XMEfKoZWSluv10tr5WXh5riF';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ptgrcseudavkaviwdgzo.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const K6_BIN = 'C:\\Program Files\\k6\\k6.exe';
const PARTICIPANTS_COUNT = Number(getArg('--participants', 750));
const BURST_SECONDS = Number(getArg('--burst-seconds', 5));
const DUPLICATE_PERCENT = Number(getArg('--duplicate-percent', 10));

const defaultHeaders = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
};
if (BYPASS_SECRET) {
  defaultHeaders['x-vercel-protection-bypass'] = BYPASS_SECRET;
}

// 1. Preflight
async function runPreflight() {
  console.log('\n[Preflight] Validating targets and health...');
  console.log(`  Base URL:    ${BASE_URL}`);
  console.log(`  Gateway URL: ${GATEWAY_URL}`);

  const bootRes = await fetch(`${BASE_URL}/api/bootstrap`, { headers: defaultHeaders, signal: AbortSignal.timeout(10000) });
  if (!bootRes.ok) throw new Error(`Bootstrap failed: HTTP ${bootRes.status}`);
  const bootData = await bootRes.json();
  const eventId = bootData.state?.eventId || bootData.eventId;
  const sessionId = bootData.state?.sessionId || bootData.sessionId;

  const healthRes = await fetch(`${GATEWAY_URL}/gateway/health`, { signal: AbortSignal.timeout(10000) });
  if (!healthRes.ok) throw new Error(`Gateway health failed: HTTP ${healthRes.status}`);
  const healthData = await healthRes.json();

  if (!healthData.durableSinkConfigured) throw new Error('Gateway durable sink is not configured');
  if (healthData.queueDepth !== 0) throw new Error(`Gateway queue not empty before start (${healthData.queueDepth})`);

  console.log(`  ✓ Preview ready (Event: ${eventId}, Session: ${sessionId})`);
  console.log(`  ✓ Gateway ready (Status: ${healthData.status}, Queue: ${healthData.queueDepth}, Connected: ${healthData.connectedClients})`);

  return { eventId, sessionId, currentVersion: healthData.currentVersion };
}

// 2. Prepare 750 Rehearsal Participants
async function prepareRehearsalParticipants(runId, outDir, eventId, sessionId) {
  console.log(`\n[Prepare] Generating ${PARTICIPANTS_COUNT} rehearsal participants...`);
  const manifestPath = path.join(outDir, 'credentials.json');
  const aliasPrefix = `Rehk6ind${Date.now().toString(36).slice(-4)}`;

  const participants = [];
  const concurrency = 20;
  let registered = 0;
  const t0 = Date.now();

  const worker = async (indices) => {
    for (const i of indices) {
      let currentAlias = `${aliasPrefix}${String(i).padStart(4, '0')}`;
      let success = false;
      let lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const payload = {
            alias: currentAlias,
            eventId,
            is_rehearsal: true,
            rehearsal: true
          };

          const res = await fetch(`${BASE_URL}/api/participants`, {
            method: 'POST',
            headers: defaultHeaders,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(25000)
          });

          if (res.status === 409) {
            currentAlias = `${aliasPrefix}${String(i).padStart(4, '0')}${Math.random().toString(36).slice(2, 5)}`;
            await new Promise(r => setTimeout(r, 200));
            continue;
          }

          if (!res.ok) {
            const txt = await res.text();
            throw new Error(`HTTP ${res.status}: ${txt}`);
          }
          const data = await res.json();
          participants.push({
            index: i,
            id: data.participant.id,
            alias: data.participant.alias,
            token: data.token,
            credential: data.credential,
            isRehearsal: true
          });
          success = true;
          break;
        } catch (err) {
          lastErr = err;
          currentAlias = `${aliasPrefix}${String(i).padStart(4, '0')}${Math.random().toString(36).slice(2, 5)}`;
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
      }

      if (!success) {
        throw new Error(`Failed to register participant index ${i}: ${lastErr?.message}`);
      }

      registered++;
      if (registered % 50 === 0 || registered === PARTICIPANTS_COUNT) {
        const rate = (registered / ((Date.now() - t0) / 1000)).toFixed(1);
        console.log(`  [Prepare] Registered ${registered}/${PARTICIPANTS_COUNT} (~${rate}/s)`);
      }
    }
  };

  // Partition indices among concurrency workers
  const buckets = Array.from({ length: concurrency }, () => []);
  for (let i = 1; i <= PARTICIPANTS_COUNT; i++) {
    buckets[(i - 1) % concurrency].push(i);
  }

  await Promise.all(buckets.map(b => worker(b)));

  // Sort participants by index
  participants.sort((a, b) => a.index - b.index);

  const manifestData = {
    runId,
    timestamp: new Date().toISOString(),
    baseUrl: BASE_URL,
    gatewayUrl: GATEWAY_URL,
    eventId,
    sessionId,
    count: participants.length,
    participants
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2));
  console.log(`  ✓ Finished! Saved ${participants.length} credentials to ${manifestPath} (${((Date.now() - t0) / 1000).toFixed(1)}s total)`);
  return { manifestPath, participants };
}

// 3. Admin Authentication & Open Real Quiz Question
async function openRealQuestion() {
  console.log('\n[Admin] Authenticating and selecting real quiz question...');
  const loginRes = await fetch(`${BASE_URL}/api/admin/login`, {
    method: 'POST',
    headers: defaultHeaders,
    body: JSON.stringify({ pin: ADMIN_PIN }),
    signal: AbortSignal.timeout(10000)
  });
  if (!loginRes.ok) throw new Error(`Admin login failed: HTTP ${loginRes.status}`);
  const { token: adminToken } = await loginRes.json();
  const adminHeaders = { ...defaultHeaders, Authorization: `Bearer ${adminToken}` };

  const statusRes = await fetch(`${BASE_URL}/api/admin/status`, {
    headers: adminHeaders,
    signal: AbortSignal.timeout(10000)
  });
  if (!statusRes.ok) throw new Error(`Admin status failed: HTTP ${statusRes.status}`);
  const statusData = await statusRes.json();
  const questions = (statusData.questions || []).filter(q => (q.reviewStatus === 'approved' || q.review_status === 'approved') && !q.isVoid);
  if (!questions.length) throw new Error('No approved questions found');

  const selectedQuestion = questions[0];
  console.log(`  Selected Question: "${selectedQuestion.question}" (ID: ${selectedQuestion.id})`);

  console.log(`  Opening question for answers via Admin API...`);
  const openRes = await fetch(`${BASE_URL}/api/admin/action`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ kind: 'open_question', questionId: selectedQuestion.id }),
    signal: AbortSignal.timeout(10000)
  });
  if (!openRes.ok) {
    const txt = await openRes.text();
    throw new Error(`Failed to open question: HTTP ${openRes.status} - ${txt}`);
  }
  const openData = await openRes.json();
  const openedVersion = openData.session?.version;
  const deadlineAt = new Date(openData.session?.deadline_at).getTime();
  console.log(`  ✓ Question opened (Version: ${openedVersion}, Deadline: ${openData.session?.deadline_at})`);

  // Wait for gateway to confirm open state
  let gatewayOpen = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const gwRes = await fetch(`${GATEWAY_URL}/gateway/state`, { signal: AbortSignal.timeout(3000) });
    if (gwRes.ok) {
      const gwState = await gwRes.json();
      if (gwState.state === 'open' && gwState.question?.id === selectedQuestion.id) {
        gatewayOpen = true;
        console.log(`  ✓ Gateway confirmed state is open for question ${selectedQuestion.id}`);
        break;
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!gatewayOpen) throw new Error('Gateway did not transition to open state in time');

  return { selectedQuestion, openedVersion, deadlineAt, adminToken };
}

// 4. Background Telemetry Collector
function startTelemetryCollector(outDir) {
  const samples = [];
  let running = true;
  const timer = setInterval(async () => {
    if (!running) return;
    try {
      const res = await fetch(`${GATEWAY_URL}/gateway/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        samples.push({
          timestamp: Date.now(),
          connectedClients: data.connectedClients,
          queueDepth: data.queueDepth,
          totalQueued: data.totalQueued,
          eventLoopLagMs: data.capacity?.eventLoopLagMs ?? 0,
          p50AckMs: data.capacity?.p50AckMs ?? 0,
          p95AckMs: data.capacity?.p95AckMs ?? 0,
          p99AckMs: data.capacity?.p99AckMs ?? 0,
          errorCount: data.capacity?.errorCount ?? 0,
          capacityStatus: data.capacity?.status ?? 'unknown'
        });
      }
    } catch (e) {
      samples.push({ timestamp: Date.now(), fetchError: e.message });
    }
  }, 500);

  return {
    stop() {
      running = false;
      clearInterval(timer);
      fs.writeFileSync(path.join(outDir, 'gateway-telemetry.json'), JSON.stringify(samples, null, 2));
      return samples;
    },
    getSamples() {
      return samples;
    }
  };
}

// 5. Execute k6 Load Test
async function runK6Test(manifestPath, questionId, sessionId, outDir) {
  console.log(`\n[k6] Starting k6 answer burst (${PARTICIPANTS_COUNT} players, ${BURST_SECONDS}s burst, ${DUPLICATE_PERCENT}% retries)...`);
  const summaryExportPath = path.join(outDir, 'k6-summary.json');
  const rawExportPath = path.join(outDir, 'k6-raw-metrics.json');
  const scriptPath = path.join(__dirname, 'answer-burst.js');

  const safeManifest = manifestPath.replace(/\\/g, '/');
  const safeScript = scriptPath.replace(/\\/g, '/');
  const safeSummary = summaryExportPath.replace(/\\/g, '/');
  const safeRaw = rawExportPath.replace(/\\/g, '/');

  const args = [
    'run',
    '--summary-trend-stats', 'avg,min,med,max,p(50),p(90),p(95),p(99)',
    '--summary-export', safeSummary,
    '--out', `json=${safeRaw}`,
    '-e', `MANIFEST_PATH=${safeManifest}`,
    '-e', `GATEWAY_URL=${GATEWAY_URL}`,
    '-e', `QUESTION_ID=${questionId}`,
    '-e', `SESSION_ID=${sessionId}`,
    '-e', `BURST_SECONDS=${BURST_SECONDS}`,
    '-e', `DUPLICATE_PERCENT=${DUPLICATE_PERCENT}`,
    safeScript
  ];

  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawn(K6_BIN, args, {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => {
      const str = d.toString('utf8');
      stdout += str;
      process.stdout.write(str);
    });
    proc.stderr.on('data', d => {
      const str = d.toString('utf8');
      stderr += str;
      process.stderr.write(str);
    });

    proc.on('close', code => {
      const durationMs = Date.now() - startTime;
      console.log(`\n[k6] Process exited with code ${code} in ${(durationMs / 1000).toFixed(2)}s`);
      if (code !== 0 && code !== 99) { // 99 is threshold breach
        return reject(new Error(`k6 failed with exit code ${code}: ${stderr}`));
      }
      resolve({ code, stdout, stderr, durationMs, summaryExportPath, rawExportPath });
    });
  });
}

// 6. Monitor Queue Drain
async function waitForQueueDrain() {
  console.log('\n[Drain] Monitoring gateway queue drain...');
  const t0 = Date.now();
  let drained = false;
  let lastDepth = -1;

  while (Date.now() - t0 < 30000) {
    try {
      const res = await fetch(`${GATEWAY_URL}/gateway/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        lastDepth = data.queueDepth;
        if (data.queueDepth === 0) {
          drained = true;
          break;
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }

  const drainDurationMs = Date.now() - t0;
  if (!drained) {
    throw new Error(`Gateway queue failed to drain within 30s; remaining depth: ${lastDepth}`);
  }
  console.log(`  ✓ Gateway queue fully drained to 0 in ${drainDurationMs}ms`);
  return { drained, drainDurationMs };
}

// 7. Verify Durability in Supabase
async function verifyDurability(participants, questionId, outDir) {
  console.log('\n[Durability] Verifying all answers recorded in Supabase database...');
  if (!SUPABASE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for durable verification');

  const ids = participants.map(p => p.id);
  const rows = [];
  const batchSize = 50;

  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const url = new URL('/rest/v1/gateway_answers', SUPABASE_URL);
    url.searchParams.set('participant_id', `in.(${chunk.join(',')})`);
    url.searchParams.set('question_id', `eq.${questionId}`);
    url.searchParams.set('select', 'id,participant_id,session_id,question_id,option_index,response_ms,idempotency_key,received_at');

    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) throw new Error(`Supabase query failed: HTTP ${res.status}`);
    const chunkRows = await res.json();
    rows.push(...chunkRows);
  }

  const errors = [];
  for (const p of participants) {
    const matches = rows.filter(r => r.participant_id === p.id);
    if (matches.length !== 1) {
      errors.push(`Participant ${p.id} (${p.alias}) has ${matches.length} durable answers (expected 1)`);
    }
  }

  const passed = errors.length === 0 && rows.length === participants.length;
  const result = {
    passed,
    expected: participants.length,
    durableCount: rows.length,
    errors,
    sampleRows: rows.slice(0, 5)
  };

  fs.writeFileSync(path.join(outDir, 'durable-verification.json'), JSON.stringify(result, null, 2));
  console.log(`  ✓ Durability verification: ${rows.length}/${participants.length} answers durably saved (${passed ? 'PASSED' : 'FAILED'})`);
  if (!passed) {
    console.error('  Durability errors:', errors.slice(0, 5));
  }
  return result;
}

// Main Orchestrator
async function main() {
  const runId = getArg('--run-id', `k6-${PARTICIPANTS_COUNT}p-r${Date.now()}`);
  const outDir = path.join(rootDir, 'artifacts', 'load', runId);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`=============================================================`);
  console.log(`  INDEPENDENT 750-PLAYER k6 LOAD TEST`);
  console.log(`  Run ID: ${runId}`);
  console.log(`  Output: ${outDir}`);
  console.log(`=============================================================`);

  // Step 1: Preflight
  const preflight = await runPreflight();

  // Step 2: Prepare Participants
  const { manifestPath, participants } = await prepareRehearsalParticipants(runId, outDir, preflight.eventId, preflight.sessionId);

  // Step 3: Open Question
  const { selectedQuestion, openedVersion, deadlineAt } = await openRealQuestion();

  // Step 4: Start Telemetry Collector
  const collector = startTelemetryCollector(outDir);

  // Step 5: Run k6 Load Test
  let k6Result;
  try {
    k6Result = await runK6Test(manifestPath, selectedQuestion.id, preflight.sessionId, outDir);
  } catch (err) {
    console.error('[k6 Error]', err);
    collector.stop();
    throw err;
  }

  // Step 6: Queue Drain
  const drainResult = await waitForQueueDrain();

  // Wait for deadline to expire for clean state
  const remainingDeadline = Math.max(0, deadlineAt - Date.now() + 1000);
  console.log(`\nWaiting for answer deadline to complete (${(remainingDeadline / 1000).toFixed(1)}s)...`);
  await new Promise(r => setTimeout(r, remainingDeadline));

  // Trigger reveal and measure latency
  console.log('\n[Reveal] Triggering answer reveal and measuring transition latency...');
  const tReveal0 = Date.now();
  let revealDurationMs = -1;
  let revealOk = false;
  try {
    const adminHeaders = { ...defaultHeaders, Authorization: `Bearer ${adminToken}` };
    const revealRes = await fetch(`${BASE_URL}/api/admin/action`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ state: 'revealed' }),
      signal: AbortSignal.timeout(15000)
    });
    revealDurationMs = Date.now() - tReveal0;
    revealOk = revealRes.ok;
    console.log(`  ✓ Reveal response returned in ${revealDurationMs}ms (HTTP ${revealRes.status})`);
  } catch (err) {
    console.warn(`  ⚠ Reveal request error: ${err.message}`);
  }

  // Stop Telemetry Collector
  const telemetrySamples = collector.stop();

  // Step 7: Verify Durability
  const durableResult = await verifyDurability(participants, selectedQuestion.id, outDir);

  // Step 8: Parse and Analyze Metrics
  const summaryJson = JSON.parse(fs.readFileSync(k6Result.summaryExportPath, 'utf8'));

  // Telemetry summary
  const validSamples = telemetrySamples.filter(s => !s.fetchError);
  const peakQueue = Math.max(...validSamples.map(s => s.queueDepth), 0);
  const maxLag = Math.max(...validSamples.map(s => s.eventLoopLagMs), 0);
  const maxP50Ack = Math.max(...validSamples.map(s => s.p50AckMs), 0);
  const maxP95Ack = Math.max(...validSamples.map(s => s.p95AckMs), 0);
  const maxP99Ack = Math.max(...validSamples.map(s => s.p99AckMs), 0);
  const peakConnected = Math.max(...validSamples.map(s => s.connectedClients), 0);

  // Prior Node Run Baseline (from artifacts/load/analysis-750/round-1-attempts.json)
  const priorNodeBaseline = {
    runId: 'cloud-750p-r36117786399',
    generator: 'Node.js test harness (undici fetch + SSE Observer)',
    totalRequests: 825,
    primaryAttempts: 750,
    duplicateAttempts: 75,
    acceptedPrimary: 750,
    acceptedDuplicates: 75,
    httpFailures: 0,
    runnerAckLatenciesMs: {
      p50: 842.88,
      p95: 5170.37, // 5.17s
      p99: 5382.05,
      max: 5548.98,
      avg: 1984.60
    },
    gatewayAckLatenciesMs: {
      p50: 18,
      p95: 180, // ~86 - 180ms
      p99: 195
    },
    peakQueueDepth: 189,
    connectedSSEClients: 750,
    durableZeroLoss: true
  };

  // k6 Metrics Extraction
  const m = summaryJson.metrics || {};
  const getTrend = (name) => {
    const t = m[name];
    if (!t) return { p50: 0, p90: 0, p95: 0, p99: 0, avg: 0, min: 0, max: 0 };
    return {
      min: Number((t.min ?? 0).toFixed(2)),
      p50: Number((t['p(50)'] ?? t.med ?? 0).toFixed(2)),
      p90: Number((t['p(90)'] ?? 0).toFixed(2)),
      p95: Number((t['p(95)'] ?? 0).toFixed(2)),
      p99: Number((t['p(99)'] ?? 0).toFixed(2)),
      max: Number((t.max ?? 0).toFixed(2)),
      avg: Number((t.avg ?? 0).toFixed(2)),
    };
  };

  const k6Report = {
    runId,
    timestamp: new Date().toISOString(),
    generator: 'k6 (Go v2.2.0 multi-threaded goroutines)',
    testConfig: {
      participants: PARTICIPANTS_COUNT,
      burstSeconds: BURST_SECONDS,
      duplicatePercent: DUPLICATE_PERCENT,
      questionId: selectedQuestion.id,
      sessionId: preflight.sessionId,
      targetGateway: GATEWAY_URL,
      targetPreview: BASE_URL
    },
    revealMetrics: {
      revealDurationMs,
      revealOk
    },
    requests: {
      total: m.http_reqs?.count ?? 0,
      rate: Number((m.http_reqs?.rate ?? 0).toFixed(2)),
      failed: m.http_req_failed?.passes ?? 0,
      success200: m.http_req_failed?.fails ?? 0,
      acceptedAnswers: m.accepted_answers?.count ?? 0,
      duplicateAnswers: m.duplicate_answers?.count ?? 0,
      failedAnswers: m.failed_answers?.count ?? 0
    },
    detailedTimingBreakdownMs: {
      http_req_blocked: getTrend('http_req_blocked'),
      http_req_connecting: getTrend('http_req_connecting'),
      http_req_tls_handshaking: getTrend('http_req_tls_handshaking'),
      http_req_sending: getTrend('http_req_sending'),
      http_req_waiting_ttfb: getTrend('http_req_waiting'),
      http_req_receiving: getTrend('http_req_receiving'),
      total_http_req_duration: getTrend('http_req_duration'),
      custom_answer_ack_duration: getTrend('answer_ack_duration'),
      primary_ack_duration: getTrend('primary_ack_duration'),
      retry_ack_duration: getTrend('retry_ack_duration')
    },
    gatewayTelemetry: {
      peakQueueDepth: peakQueue,
      drainTimeMs: drainResult.drainDurationMs,
      internalAckLatenciesMs: {
        p50: maxP50Ack,
        p95: maxP95Ack,
        p99: maxP99Ack
      },
      maxEventLoopLagMs: maxLag,
      connectedSSEClients: peakConnected,
      durableVerificationPassed: durableResult.passed,
      durableAnswersCount: durableResult.durableCount
    },
    sideBySideComparison: {
      priorNodeRun: priorNodeBaseline,
      k6IndependentRun: {
        runId,
        totalRequests: m.http_reqs?.count ?? 0,
        acceptedCount: (m.accepted_answers?.count ?? 0) + (m.duplicate_answers?.count ?? 0),
        runnerAckLatenciesMs: getTrend('answer_ack_duration'),
        gatewayAckLatenciesMs: {
          p50: maxP50Ack,
          p95: maxP95Ack,
          p99: maxP99Ack
        },
        peakQueueDepth: peakQueue,
        drainTimeMs: drainResult.drainDurationMs,
        connectedSSEClients: peakConnected,
        durableZeroLoss: durableResult.passed
      }
    }
  };

  const finalReportPath = path.join(outDir, 'k6-750p-report.json');
  fs.writeFileSync(finalReportPath, JSON.stringify(k6Report, null, 2));

  console.log(`\n=============================================================`);
  console.log(`  FINAL REPORT SAVED: ${finalReportPath}`);
  console.log(`=============================================================`);
  console.log(JSON.stringify(k6Report.sideBySideComparison, null, 2));
}

main().catch(err => {
  console.error('\n[Orchestrator Fatal Error]', err);
  process.exit(1);
});
