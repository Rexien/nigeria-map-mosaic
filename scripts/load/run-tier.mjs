// scripts/load/run-tier.mjs
// Master orchestrator for running a calibrated load tier across persistent SSE streams,
// synchronized HTTP answer submissions, duplicate retries, and reveal barriers.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SSEObserverPool } from './sse-observer.mjs';
import { MetricsCollector } from './collect.mjs';
import { submitAnswer, computeLatencyPercentiles } from './client-worker.mjs';
import { verifyDurableAnswers } from './durable.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function selectApprovedQuestions(questions, questionMode = 'first-approved') {
  const approved = questions.filter(q =>
    (q.reviewStatus === 'approved' || q.review_status === 'approved') &&
    !(q.isVoid ?? q.is_void ?? false)
  );
  if (questionMode === 'first-approved') return approved;
  if (questionMode === 'open-image') {
    return approved.filter(q => q.media?.src && q.media?.timing === 'question');
  }
  throw new Error(`Unknown question mode: ${questionMode}`);
}

export async function fetchQuestionImageBurst({ assetUrl, clientCount, headers = {}, fetchImpl = fetch }) {
  const results = await Promise.all(Array.from({ length: clientCount }, async () => {
    const startedAt = performance.now();
    try {
      const response = await fetchImpl(assetUrl, { headers, signal: AbortSignal.timeout(15000) });
      const bytes = await response.arrayBuffer();
      return {
        ok: response.ok && (response.headers.get('content-type') || '').toLowerCase().startsWith('image/'),
        status: response.status,
        durationMs: performance.now() - startedAt,
        bytes: bytes.byteLength
      };
    } catch (error) {
      return { ok: false, status: 0, durationMs: performance.now() - startedAt, bytes: 0, error: error.message };
    }
  }));
  const latencies = computeLatencyPercentiles(results.map(r => r.durationMs));
  return {
    requested: clientCount,
    succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    totalBytes: results.reduce((sum, r) => sum + r.bytes, 0),
    statuses: results.reduce((counts, r) => ({ ...counts, [r.status]: (counts[r.status] || 0) + 1 }), {}),
    latencies
  };
}

export async function waitForAnswerStart(openedAt, deadlineAt, burstSeconds, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const openMs = new Date(openedAt).getTime();
  const deadlineMs = new Date(deadlineAt).getTime();
  if (!Number.isFinite(openMs) || !Number.isFinite(deadlineMs) || deadlineMs <= openMs) {
    throw new Error('Invalid scheduled question start or deadline');
  }
  const waitMs = Math.max(0, openMs - now() + 150);
  if (waitMs) await sleep(waitMs);
  if (deadlineMs - now() < burstSeconds * 1000 + 4000) {
    throw new Error('Insufficient remaining answer window after scheduled start');
  }
  return { scheduledOpenedAt: openedAt, waitedMs: waitMs, dispatchAt: new Date(now()).toISOString() };
}

export function scoreSnapshotMatches(data, revealedVersion) {
  return Number.isFinite(Number(data?.snapshotVersion)) && Number(data.snapshotVersion) >= Number(revealedVersion);
}

export async function runTier(options = {}) {
  const env = options.env || process.env;
  const baseUrl = (options.baseUrl || env.NIAC_BASE_URL || 'https://niaclive-git-feature-admin-pin-auth-zamijudes-projects.vercel.app').replace(/\/$/, '');
  const gatewayUrl = (options.gatewayUrl || env.NIAC_GATEWAY_URL || 'https://92.4.146.91.sslip.io').replace(/\/$/, '');
  const runId = options.runId || env.NIAC_RUN_ID;
  if (!runId) throw new Error('Run ID is required (--run-id)');

  const outDir = options.outDir || env.NIAC_RESULTS_DIR || path.join(__dirname, '..', '..', 'artifacts', 'load', runId);
  const manifestPath = path.join(outDir, 'credentials.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found at ${manifestPath}. Run prepare.mjs first.`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const allParticipants = manifest.participants;
  const targetParticipants = Number(options.participants || allParticipants.length);
  const participants = allParticipants.slice(0, targetParticipants);

  const burstSeconds = Number(options.burstSeconds || 5);
  const duplicatePercent = Number(options.duplicatePercent || 10);
  const rounds = Number(options.rounds || 1);
  const fanoutAbortMs = Number(options.fanoutAbortMs || 2000);
  const questionMode = options.questionMode || 'first-approved';
  const adminPin = options.adminPin || env.ADMIN_PIN;
  if(!adminPin)throw new Error('ADMIN_PIN is required');
  if(!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)throw new Error('Refusing load without durable verification credentials');
  if(!Number.isInteger(rounds)||rounds<1||!Number.isInteger(targetParticipants)||targetParticipants<1||participants.length!==targetParticipants||burstSeconds<1||duplicatePercent<0||duplicatePercent>100||fanoutAbortMs<2000)throw new Error('Invalid tier parameters');
  if(manifest.baseUrl!==baseUrl || manifest.gatewayUrl!==gatewayUrl)throw new Error('Manifest target mismatch');
  const bypassSecret = env.VERCEL_AUTOMATION_BYPASS_SECRET || null;

  console.log(`\n=============================================================`);
  console.log(`  NIAC Live: Calibrated Rehearsal Ladder Tier`);
  console.log(`  Scale: ${participants.length} Active Participants`);
  console.log(`  Burst Window: ${burstSeconds}s | Retries: ${duplicatePercent}% | Rounds: ${rounds}`);
  console.log(`  Target Authority: ${baseUrl}`);
  console.log(`  Target Gateway:   ${gatewayUrl}`);
  console.log(`=============================================================\n`);

  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (bypassSecret) headers['x-vercel-protection-bypass'] = bypassSecret;

  // 1. Authenticate Admin
  console.log('[Tier Step 1/6] Authenticating as admin...');
  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ pin: adminPin })
  });
  if (!loginRes.ok) throw new Error(`Admin login failed: HTTP ${loginRes.status}`);
  const { token: adminToken } = await loginRes.json();
  const adminHeaders = { ...headers, 'Authorization': `Bearer ${adminToken}` };

  // 2. Start Telemetry Collector & SSE Observer Pool
  console.log('[Tier Step 2/6] Starting telemetry collector and SSE observer pool...');
  const collector = new MetricsCollector({ gatewayUrl, intervalMs: 1000 });
  collector.start();

  const observer = new SSEObserverPool({ gatewayUrl, participants });
  try {
  await observer.start();
  await observer.waitForConnections(participants.length, 25000);

  // 3. Fetch Admin Status & Questions
  console.log('[Tier Step 3/6] Fetching approved questions bank...');
  const statusRes = await fetch(`${baseUrl}/api/admin/status`, { headers: adminHeaders });
  if (!statusRes.ok) throw new Error(`Admin status failed: HTTP ${statusRes.status}`);
  const statusData = await statusRes.json();
  const sessionId = statusData.session?.id;
  const questions = statusData.questions || [];
  const approvedQuestions = selectApprovedQuestions(questions, questionMode);

  if (!approvedQuestions.length) {
    if (questionMode === 'open-image') throw new Error('No approved question has an image shown while answers are open');
    throw new Error('No approved questions found');
  }
  if(rounds>approvedQuestions.length)throw new Error('Cannot reuse questions for the same participant identities');
  console.log(`  Found ${approvedQuestions.length} approved questions for live rounds (${questionMode}).`);

  const roundReports = [];
  let lastRevealVersion = null;

  // 4. Execute Rounds
  for (let r = 0; r < rounds; r++) {
    const qIndex = r % approvedQuestions.length;
    const currentQ = approvedQuestions[qIndex];
    console.log(`\n--- [Round ${r + 1}/${rounds}] Question: "${currentQ.question}" (ID: ${currentQ.id}) ---`);

    // Open Question
    const commandStartedAt=Date.now();
    const openRes = await fetch(`${baseUrl}/api/admin/action`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        kind: 'open_question',
        questionId: currentQ.id
      })
    });

    if (!openRes.ok) {
      const err = await openRes.text();
      throw new Error(`Failed to open question: HTTP ${openRes.status} - ${err}`);
    }
    const openData = await openRes.json();
    console.log(`  Admin open timing: ${openRes.headers.get('server-timing') || 'not reported'}; client total ${Date.now() - commandStartedAt}ms`);
    const openVersion = openData.session.version;
    observer.commandStarts.set(openVersion,commandStartedAt);
    if(openData.session.id!==sessionId)throw new Error('Session changed during test');
    const openedAt = openData.session.opened_at;
    const deadlineAt = new Date(openData.session.deadline_at).getTime();
    console.log(`  ✓ Question Prepared (v${openVersion}). Answers open: ${openedAt}; deadline: ${openData.session.deadline_at}`);

    let imageBurst = null;
    if (currentQ.media?.src && currentQ.media?.timing === 'question') {
      const assetUrl = new URL(currentQ.media.src, baseUrl).toString();
      console.log(`  Loading question image for ${participants.length} simulated clients: ${assetUrl}`);
      imageBurst = await fetchQuestionImageBurst({ assetUrl, clientCount: participants.length, headers });
      console.log(`  Image fetches: ${imageBurst.succeeded}/${imageBurst.requested}; p95 ${imageBurst.latencies.p95}ms; ${imageBurst.totalBytes} bytes transferred`);
      if (imageBurst.failed) throw new Error(`Question image failed to load for ${imageBurst.failed}/${imageBurst.requested} simulated clients`);
    }

    // Wait up to the acceptance boundary for every listener, then evaluate latency.
    const fanout = await observer.waitForFanout(openVersion,participants.length,3000);
    if (fanout) {
      console.log(`  ✓ Fanout Receipt: ${fanout.receivedCount}/${participants.length} streams (p50: ${fanout.p50Ms}ms, p95: ${fanout.p95Ms}ms)`);
    }
    if(!fanout || fanout.receivedCount!==participants.length || fanout.p99Ms>fanoutAbortMs)throw new Error('Fanout gate failed; no answer burst sent');
    const startTiming = await waitForAnswerStart(openedAt, openData.session.deadline_at, burstSeconds);
    console.log(`  ✓ Scheduled start reached; waited ${startTiming.waitedMs}ms before submitting`);

    // Schedule and dispatch answers
    console.log(`  Ingesting answers across ${burstSeconds}s burst window...`);
    const totalDurationMs = burstSeconds * 1000;
    const answerPromises = [];
    const submissionResults = [];

    const numDuplicates = Math.floor(participants.length * (duplicatePercent / 100));
    const duplicateIndices = new Set();
    while (duplicateIndices.size < numDuplicates) {
      duplicateIndices.add(Math.floor(Math.random() * participants.length));
    }

    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      // Stagger submissions within burst window
      const offsetMs = Math.floor(i * totalDurationMs / participants.length);
      const chosenOption = (i % 4);

      const pPromise = (async () => {
        await new Promise(res => setTimeout(res, offsetMs));
        const res = await submitAnswer({
          gatewayUrl,
          participant: p,
          sessionId,
          questionId: currentQ.id,
          optionIndex: chosenOption,
          bypassSecret
        });
        submissionResults.push(res);

        // Duplicate retry simulation
        if (duplicateIndices.has(i)) {
          await new Promise(res => setTimeout(res, 300 + Math.random() * 500));
          const dupRes = await submitAnswer({
            gatewayUrl,
            participant: p,
            sessionId,
            questionId: currentQ.id,
            optionIndex: chosenOption,
            isDuplicate: true,
            existingKey: res.idempotencyKey,
            bypassSecret
          });
          submissionResults.push(dupRes);
        }
      })();

      answerPromises.push(pPromise);
    }

    await Promise.all(answerPromises);

    fs.writeFileSync(path.join(outDir,`round-${r+1}-attempts.json`),JSON.stringify(submissionResults,null,2));
    const firstAttempts = submissionResults.filter(s => s.attemptKind==='first');
    const duplicates = submissionResults.filter(s => s.attemptKind==='retry' && s.accepted && s.duplicate);
    const acceptedCount = firstAttempts.filter(s => s.accepted).length;
    const latencies = computeLatencyPercentiles(submissionResults.map(s => s.durationMs));

    console.log(`  ✓ Answer Ingestion Complete:`);
    console.log(`    - First Attempts: ${firstAttempts.length} (Accepted: ${acceptedCount}/${participants.length})`);
    console.log(`    - Duplicates:     ${duplicates.length}`);
    console.log(`    - Latency (p50):  ${latencies.p50}ms | (p95): ${latencies.p95}ms | (max): ${latencies.max}ms`);

    // Wait until deadline expires
    const now = Date.now();
    const waitToDeadline = Math.max(0, deadlineAt - now + 1000);
    console.log(`  Waiting for deadline & auto-reveal (${Math.round(waitToDeadline / 1000)}s)...`);
    await new Promise(res => setTimeout(res, waitToDeadline));

    // Poll until revealed and queue drained
    let revealed = false;
    let revealVersion = null;
    let revealSeenAt = null;
    let pollCount = 0;
    while (!revealed && pollCount < 15) {
      await new Promise(res => setTimeout(res, 1000));
      pollCount++;
      const stateRes = await fetch(`${baseUrl}/api/state`, { headers });
      if (stateRes.ok) {
        const stateData = await stateRes.json();
        if (stateData.state === 'revealed' && stateData.question?.id === currentQ.id) {
          revealed = true;
          revealVersion = Number(stateData.version);
          revealSeenAt = Date.now();
        }
      }
    }

    if (!revealed) {
      throw new Error('Automatic reveal failed; stopped without forcing success');
    }
    lastRevealVersion = revealVersion;
    const durable=await verifyDurableAnswers(submissionResults,env);
    fs.writeFileSync(path.join(outDir,`round-${r+1}-durable.json`),JSON.stringify(durable,null,2));
    const healthResponse=await fetch(`${gatewayUrl}/gateway/health`,{signal:AbortSignal.timeout(5000)});
    if(!healthResponse.ok)throw new Error('Cannot verify drained queue');
    const health=await healthResponse.json();
    if(!durable.passed || health.queueDepth!==0 || acceptedCount!==participants.length || duplicates.length!==numDuplicates)throw new Error(`Round ${r+1} failed acceptance/durability gates; evidence saved; ladder stopped`);
    // Strict latency goals still fail the final report. Abort the ladder immediately only
    // when latency is severe enough to threaten a live 20-second answer window.
    const severeLatency = latencies.p95 > 10000 || latencies.p99 > 12000 || latencies.max > 15000;
    let scoreReadyAt = null;
    const scoreWaitDeadline = Date.now() + 30000;
    while (Date.now() < scoreWaitDeadline) {
      const stateRes = await fetch(`${baseUrl}/api/state`, { headers, signal: AbortSignal.timeout(8000) });
      if (stateRes.ok) {
        const stateData = await stateRes.json();
        if (Number(stateData.version) === revealVersion && stateData.state === 'revealed' && stateData.scoreReady === true) {
          scoreReadyAt = Date.now();
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!scoreReadyAt) throw new Error(`Scores did not become ready for revealed version ${revealVersion} within 30s`);
    console.log(`  ✓ Answer Revealed; scores ready ${scoreReadyAt - revealSeenAt}ms later.`);
    roundReports.push({
      round: r + 1,
      questionId: currentQ.id,
      participants: participants.length,
      acceptedCount,
      duplicateCount: duplicates.length,
      durable,
      fanout,
      latencies,
      imageBurst,
      startTiming,
      deadlineToRevealMs: revealSeenAt - deadlineAt,
      revealToScoresReadyMs: scoreReadyAt - revealSeenAt,
      revealedVersion: revealVersion,
      severeLatency
    });
    if (severeLatency) {
      console.warn(`Round ${r+1} exceeded the severe latency abort gate; no further rounds will open`);
      break;
    }
  }

  // 5. Post-Reveal Score Lookup Storm (Spread over 2s with retry per LOAD_TEST_PLAN.md)
  console.log('\n[Tier Step 5/6] Simulating post-reveal score lookup storm (/api/me reads spread over 2s)...');
  const readT0 = performance.now();
  const readPromises = participants.map(async (p, idx) => {
    // Jittered arrival spread across 2000ms
    const jitterMs = Math.floor(Math.random() * 2000);
    await new Promise(r => setTimeout(r, jitterMs));

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const requestStarted=performance.now();
        const res = await fetch(`${baseUrl}/api/me`, {
          headers: { ...headers, 'Authorization': `Bearer ${p.token}` },
          signal:AbortSignal.timeout(8000)
        });
        if (res.status === 200) {
          const data = await res.json();
          if (scoreSnapshotMatches(data, lastRevealVersion)) {
            return {ok:true,durationMs:performance.now()-requestStarted,snapshotVersion:data.snapshotVersion};
          }
        } else {
          await res.arrayBuffer();
        }
      } catch (err) {
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
        }
      }
    }
    return {ok:false};
  });
  const readResults = await Promise.all(readPromises);
  const readDuration = performance.now() - readT0;
  const readPassCount = readResults.filter(r=>r.ok).length;
  const readLatencies=computeLatencyPercentiles(readResults.filter(r=>r.ok).map(r=>r.durationMs));
  console.log(`  Score Lookups: ${readPassCount}/${participants.length}; wall time ${readDuration.toFixed(2)}ms; successful-request p95 ${readLatencies.p95}ms (failures counted separately)`);

  // 6. Final Summary & Gate Verification
  console.log('\n[Tier Step 6/6] Compiling tier telemetry and evaluating gates...');
  observer.stop();
  collector.stop();
  const telemetrySummary = collector.getSummary();

  const totalFirstAttempts = roundReports.reduce((acc, r) => acc + r.acceptedCount, 0);
  const expectedTotal = participants.length * rounds;
  const zeroLoss = totalFirstAttempts === expectedTotal;
  const p95WithinSla = roundReports.every(r => r.latencies.p95 <= 1000 && r.latencies.p99 <= 1500);
  const fanoutWithinSla = roundReports.every(r => r.fanout.p95Ms <= 1000 && r.fanout.p99Ms <= 2000);
  const readsWithinSla = readPassCount === participants.length && readLatencies.p95 <= 1000 && readLatencies.p99 <= 2000;

  const passed = zeroLoss && p95WithinSla && fanoutWithinSla && readsWithinSla &&
    roundReports.every(r=>r.durable.passed && !r.severeLatency);

  const report = {
    runId,
    timestamp: new Date().toISOString(),
    participantsCount: participants.length,
    rounds,
    burstSeconds,
    duplicatePercent,
    zeroLoss,
    p95WithinSla,
    fanoutWithinSla,
    readsWithinSla,
    fanoutAbortMs,
    readPassCount,
    readLatencies,
    certification:'Partial answer-path test only; full scoring, recovery and resource gates remain required',
    telemetrySummary,
    roundReports,
    passed
  };

  const reportPath = path.join(outDir, `tier-${participants.length}-report.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n=============================================================`);
  console.log(`  TIER RESULT FOR ${participants.length} PARTICIPANTS: ${passed ? 'PASSED' : 'FAILED'}`);
  console.log(`  - Zero Loss Gate:  ${zeroLoss ? 'PASS' : 'FAIL'} (${totalFirstAttempts}/${expectedTotal})`);
  console.log(`  - p95 Latency SLA: ${p95WithinSla ? 'PASS' : 'FAIL'}`);
  console.log(`  - Fanout SLA:      ${fanoutWithinSla ? 'PASS' : 'FAIL'}`);
  console.log(`  - Score-read SLA:  ${readsWithinSla ? 'PASS' : 'FAIL'}`);
  console.log(`  - Report File:     ${reportPath}`);
  console.log(`=============================================================\n`);

  return report;
  } finally {
    observer.stop();
    collector.stop();
  }
}

// CLI runner
if (process.argv[1] && process.argv[1].endsWith('run-tier.mjs')) {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };

  const participants = Number(getArg('--participants', 5));
  const burstSeconds = Number(getArg('--burst-seconds', 5));
  const duplicatePercent = Number(getArg('--duplicate-percent', 10));
  const rounds = Number(getArg('--rounds', 1));
  const fanoutAbortMs = Number(getArg('--fanout-abort-ms', 2000));
  const questionMode = getArg('--question-mode', 'first-approved');
  const runId = getArg('--run-id', process.env.NIAC_RUN_ID || `rehearsal-${Date.now()}`);

  runTier({ participants, burstSeconds, duplicatePercent, rounds, fanoutAbortMs, questionMode, runId })
    .then(report => process.exit(report.passed ? 0 : 1))
    .catch(err => {
      console.error('[Run-Tier Error]', err);
      process.exit(1);
    });
}
