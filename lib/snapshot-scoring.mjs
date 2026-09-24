// NIAC Live Snapshot Scoring & Reveal Barrier (Phase 4)
// Computes scores, stamps, and leaderboards once at reveal time.
// Enables O(1) single-record reads for /api/me and /api/leaderboard without table scans.

import { formatLog, globalMetrics } from './telemetry.mjs';

/**
 * Canonical ranking comparison per NIAC Core rules:
 * 1. Total score (descending)
 * 2. Correct answers count (descending)
 * 3. Total response time for correct answers (ascending - faster wins)
 * 4. Registration timestamp (ascending - earlier joined wins)
 */
export function compareRank(a, b) {
  return (
    (b.totalScore - a.totalScore) ||
    (b.correctAnswers - a.correctAnswers) ||
    (a.correctResponseMs - b.correctResponseMs) ||
    (new Date(a.registeredAt) - new Date(b.registeredAt))
  );
}

/**
 * Accumulate Day 1 and Day 2 points for passport questions.
 * Decode and voided answers are excluded.
 */
export function accumulateDays(answers) {
  return answers.reduce((totals, answer) => {
    const isVoid = answer.voided || answer.is_void;
    const activity = answer.activity || 'passport';
    if (isVoid || activity === 'decode') return totals;
    const day = Number(answer.day || 1);
    const key = day === 2 ? 'day2' : 'day1';
    const pts = Number(answer.points || 0);
    totals[key] += pts;
    totals.combined += pts;
    return totals;
  }, { day1: 0, day2: 0, combined: 0 });
}

/**
 * Compute passport stamp progress across the 5 cultural categories:
 * food, language, entertainment, geography, everyday.
 */
export function stampProgress(answers, thresholds = { food: 1, language: 1, entertainment: 1, geography: 1, everyday: 1 }) {
  const correct = new Map();
  for (const a of answers) {
    const isVoid = a.voided || a.is_void;
    const isCorrect = a.correct || a.is_correct;
    const activity = a.activity || 'passport';
    if (isCorrect && !isVoid && activity === 'passport' && a.category) {
      const cat = String(a.category).toLowerCase();
      correct.set(cat, (correct.get(cat) || 0) + 1);
    }
  }

  return Object.entries(thresholds).map(([category, required]) => ({
    category,
    earned: (correct.get(category) || 0) >= required,
    correct: correct.get(category) || 0,
    required
  }));
}

/**
 * Compute all scores, stamps, and rank placements in a single pass.
 */
export function computeScoresAndRanks({ participants = [], answers = [], questions = [] }) {
  // Question lookup map by ID if question details are missing from answers
  const qMap = new Map();
  if (Array.isArray(questions)) {
    for (const q of questions) {
      if (q && q.id) qMap.set(q.id, q);
    }
  }

  // Bucket answers by participantId with duplicate protection
  const answersByParticipant = new Map();
  const seenParticipantQuestions = new Set();

  for (const a of answers) {
    const pId = a.participantId || a.participant_id;
    if (!pId) continue;
    const qId = a.questionId || a.question_id;
    const dedupKey = qId ? `${pId}:${qId}` : null;
    if (dedupKey && seenParticipantQuestions.has(dedupKey)) {
      // Duplicate answer for same participant and question - never award points twice
      continue;
    }
    if (a.duplicate) continue;
    if (dedupKey) seenParticipantQuestions.add(dedupKey);

    let list = answersByParticipant.get(pId);
    if (!list) {
      list = [];
      answersByParticipant.set(pId, list);
    }

    // Hydrate missing question metadata if needed
    const qInfo = qMap.get(qId);
    const activity = a.activity || qInfo?.activity || 'passport';
    const day = a.day || qInfo?.day || 1;
    const category = a.category || qInfo?.category || null;

    const correctOption = qInfo?.correct_option ?? qInfo?.correctOption;
    const optionIndex = a.optionIndex ?? a.option_index;
    const is_correct = (a.correct != null || a.is_correct != null)
      ? Boolean(a.correct || a.is_correct)
      : (correctOption != null && optionIndex != null && Number(optionIndex) === Number(correctOption));
    const clueNumber=Number(a.clueNumber ?? a.clue_number ?? 1);
    const points = a.points != null
      ? Number(a.points)
      : (is_correct ? Number(qInfo?.points ?? 1000) : 0);
    const is_void = Boolean(a.voided || a.is_void || qInfo?.is_void || qInfo?.isVoid);

    list.push({
      ...a,
      activity,
      day,
      category,
      points,
      is_correct,
      is_void,
      response_ms: Number(a.responseMs || a.response_ms || 0)
    });
  }

  // Calculate scores for each participant
  const eventCandidates = [];
  const passportCandidates = [];
  const decodeCandidates = [];
  const participantDetails = new Map();

  for (const p of participants) {
    const pId = p.id;
    const pAnswers = answersByParticipant.get(pId) || [];

    // Passport score breakdown
    const passportAnswers = pAnswers.filter(a => a.activity === 'passport' && !a.is_void);
    const dayTotals = accumulateDays(passportAnswers);
    const correctPassport = passportAnswers.filter(a => a.is_correct);
    const correctPassportCount = correctPassport.length;
    const passportCorrectMs = correctPassport.reduce((sum, a) => sum + a.response_ms, 0);

    // Decode score breakdown
    const decodeAnswers = pAnswers.filter(a => a.activity === 'decode' && !a.is_void);
    const decodePoints = decodeAnswers.reduce((sum, a) => sum + a.points, 0);
    const correctDecode = decodeAnswers.filter(a => a.is_correct);
    const correctDecodeCount = correctDecode.length;
    const decodeCorrectMs = correctDecode.reduce((sum, a) => sum + a.response_ms, 0);

    // Unified cumulative event total
    const eventTotal = dayTotals.combined + decodePoints;
    const correctTotalCount = correctPassportCount + correctDecodeCount;
    const totalCorrectMs = passportCorrectMs + decodeCorrectMs;

    // Stamp progress
    const stampsList = stampProgress(passportAnswers);
    const earnedStamps = stampsList
      .filter(s => s.earned)
      .map(s => ({ category: s.category }));

    const registeredAt = p.registeredAt || p.registered_at || new Date().toISOString();
    const isSpectator = Boolean(p.isSpectator || p.is_spectator);
    const isRehearsal = Boolean(p.isRehearsal || p.is_rehearsal);

    const pData = {
      id: pId,
      alias: p.alias,
      registeredAt,
      isSpectator,
      isRehearsal,
      scores: {
        day1: dayTotals.day1,
        day2: dayTotals.day2,
        combined: dayTotals.combined,
        passport: dayTotals.combined,
        decode: decodePoints,
        total: eventTotal
      },
      passportStats: {
        totalScore: dayTotals.combined,
        correctAnswers: correctPassportCount,
        correctResponseMs: passportCorrectMs,
        registeredAt
      },
      decodeStats: {
        totalScore: decodePoints,
        correctAnswers: correctDecodeCount,
        correctResponseMs: decodeCorrectMs,
        registeredAt
      },
      eventStats: {
        totalScore: eventTotal,
        correctAnswers: correctTotalCount,
        correctResponseMs: totalCorrectMs,
        registeredAt
      },
      stamps: earnedStamps
    };

    participantDetails.set(pId, pData);

    if (!isSpectator && !isRehearsal) {
      eventCandidates.push({
        id: pId,
        alias: p.alias,
        totalScore: eventTotal,
        passportScore: dayTotals.combined,
        decodeScore: decodePoints,
        correctAnswers: correctTotalCount,
        correctResponseMs: totalCorrectMs,
        registeredAt
      });

      passportCandidates.push({
        id: pId,
        alias: p.alias,
        totalScore: dayTotals.combined,
        correctAnswers: correctPassportCount,
        correctResponseMs: passportCorrectMs,
        registeredAt
      });

      decodeCandidates.push({
        id: pId,
        alias: p.alias,
        totalScore: decodePoints,
        correctAnswers: correctDecodeCount,
        correctResponseMs: decodeCorrectMs,
        registeredAt
      });
    }
  }

  // Sort candidates deterministically per canonical tie-break rules
  eventCandidates.sort(compareRank);
  passportCandidates.sort(compareRank);
  decodeCandidates.sort(compareRank);

  // Assign ranks
  const eventRanks = new Map();
  eventCandidates.forEach((c, idx) => {
    eventRanks.set(c.id, idx + 1);
  });

  const passportRanks = new Map();
  passportCandidates.forEach((c, idx) => {
    passportRanks.set(c.id, idx + 1);
  });

  const decodeRanks = new Map();
  decodeCandidates.forEach((c, idx) => {
    decodeRanks.set(c.id, idx + 1);
  });

  // Extract Top 10 leaders
  const eventLeaders = eventCandidates.slice(0, 10).map((c, i) => ({
    rank: i + 1,
    alias: c.alias,
    totalScore: c.totalScore,
    passportScore: c.passportScore,
    decodeScore: c.decodeScore,
    correctAnswers: c.correctAnswers,
    correctResponseMs: c.correctResponseMs,
    registeredAt: c.registeredAt
  }));

  const passportLeaders = passportCandidates.slice(0, 10).map((c, i) => ({
    rank: i + 1,
    alias: c.alias,
    totalScore: c.totalScore,
    correctAnswers: c.correctAnswers,
    correctResponseMs: c.correctResponseMs,
    registeredAt: c.registeredAt
  }));

  const decodeLeaders = decodeCandidates.slice(0, 10).map((c, i) => ({
    rank: i + 1,
    alias: c.alias,
    totalScore: c.totalScore,
    correctAnswers: c.correctAnswers,
    correctResponseMs: c.correctResponseMs,
    registeredAt: c.registeredAt
  }));

  // Build participant score snapshots
  const participantSnapshots = new Map();
  const participantSnapshotsList = [];

  for (const [pId, pData] of participantDetails) {
    const isSpectator = Boolean(pData.isSpectator);
    const rank = isSpectator || pData.isRehearsal ? null : (eventRanks.get(pId) || 1);
    const passportRank = isSpectator || pData.isRehearsal ? null : (passportRanks.get(pId) || 1);
    const decodeRank = isSpectator || pData.isRehearsal ? null : (decodeRanks.get(pId) || 1);
    const record = {
      participantId: pId,
      isSpectator,
      rank,
      eventRank: rank,
      passportRank,
      decodeRank,
      scores: pData.scores,
      stamps: pData.stamps
    };
    participantSnapshots.set(pId, record);
    participantSnapshotsList.push(record);
  }

  return {
    eventLeaders,
    passportLeaders,
    decodeLeaders,
    participantSnapshots,
    participantSnapshotsList,
    stats: {
      totalParticipants: participants.length,
      totalAnswers: answers.length
    }
  };
}

/**
 * Generate serializable snapshot structures ready for database insertion or memory caching.
 */
export function generateSnapshots({
  sessionId,
  snapshotVersion,
  participants = [],
  answers = [],
  questions = []
}) {
  const computed = computeScoresAndRanks({ participants, answers, questions });
  const createdAt = new Date().toISOString();

  const leaderboardSnapshots = [
    {
      sessionId,
      activity: 'passport',
      snapshotVersion,
      leaders: computed.eventLeaders,
      createdAt
    },
    {
      sessionId,
      activity: 'decode',
      snapshotVersion,
      leaders: computed.eventLeaders,
      createdAt
    }
  ];

  const participantScoreSnapshots = computed.participantSnapshotsList.map(record => ({
    sessionId,
    participantId: record.participantId,
    snapshotVersion,
    rank: record.rank,
    scores: record.scores,
    stamps: record.stamps,
    createdAt
  }));

  return {
    snapshotVersion,
    leaderboards: {
      passport: leaderboardSnapshots[0],
      decode: leaderboardSnapshots[1]
    },
    leaderboardSnapshots,
    participantSnapshotsMap: computed.participantSnapshots,
    participantScoreSnapshots,
    stats: computed.stats
  };
}

/**
 * Reveal-Time Sequential Barrier:
 * 1. Stop Intake: Set session state to locked/revealed, reject further submissions.
 * 2. Drain Queue: Flush pending group commits & await flusher queue depth == 0.
 * 3. Reconcile: Compare accepted count vs database persisted raw answer count.
 * 4. Snapshot Scoring: Pre-compute scores, stamps, and Top 10 leaderboards.
 * 5. Persist Snapshots: Write immutable snapshots with unique index (session_id, snapshot_version).
 */
export async function executeRevealBarrier({
  session,
  flusher = null,
  acceptedCount = null,
  getAnswersFn,
  getParticipantsFn,
  questions = [],
  persistSnapshotsFn = null,
  onStateChangeFn = null,
  drainTimeoutMs = 3000
}) {
  const barrierStart = Date.now();
  const sessionId = session?.id || 'local-session';
  const version = (session?.version || 1) + 1;

  // Step 1: Stop Intake
  if (typeof onStateChangeFn === 'function') {
    await onStateChangeFn('locked');
  }

  // Step 2: Drain Queue
  let drainDurationMs = 0;
  if (flusher && typeof flusher.drainQueue === 'function') {
    const drainStart = Date.now();
    await flusher.drainQueue(drainTimeoutMs);
    drainDurationMs = Date.now() - drainStart;
  }

  // Step 3: Fetch Data & Reconcile
  const answers = typeof getAnswersFn === 'function' ? await getAnswersFn() : [];
  const participants = typeof getParticipantsFn === 'function' ? await getParticipantsFn() : [];

  const rawAnswersCount = answers.length;
  const isReconciled = acceptedCount == null || acceptedCount === rawAnswersCount;

  if (!isReconciled) {
    console.warn(formatLog('warn', 'barrier_reconcile_mismatch', {
      sessionId,
      acceptedCount,
      rawAnswersCount,
      diff: acceptedCount - rawAnswersCount
    }));
  }

  // Step 4: Compute Snapshots
  const computeStart = Date.now();
  const snapshots = generateSnapshots({
    sessionId,
    snapshotVersion: version,
    participants,
    answers,
    questions
  });
  const computeDurationMs = Date.now() - computeStart;

  // Step 5: Persist Snapshots
  let persistDurationMs = 0;
  if (typeof persistSnapshotsFn === 'function') {
    const persistStart = Date.now();
    await persistSnapshotsFn(snapshots);
    persistDurationMs = Date.now() - persistStart;
  }

  // Step 6: Transition to Revealed
  if (typeof onStateChangeFn === 'function') {
    await onStateChangeFn('revealed', version);
  }

  const totalDurationMs = Date.now() - barrierStart;

  console.log(formatLog('info', 'reveal_barrier_complete', {
    sessionId,
    snapshotVersion: version,
    participantsCount: participants.length,
    rawAnswersCount,
    drainDurationMs,
    computeDurationMs,
    persistDurationMs,
    totalDurationMs,
    reconciled: isReconciled
  }));

  return {
    success: true,
    snapshotVersion: version,
    totalDurationMs,
    reconciliation: {
      acceptedCount: acceptedCount ?? rawAnswersCount,
      persistedCount: rawAnswersCount,
      reconciled: isReconciled
    },
    snapshots
  };
}
