import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareRank,
  accumulateDays,
  stampProgress,
  computeScoresAndRanks,
  generateSnapshots,
  executeRevealBarrier
} from '../lib/snapshot-scoring.mjs';

test('canonical tie-breaking: score desc -> correct desc -> time asc -> registered asc', () => {
  const candidates = [
    { id: 'p1', alias: 'SlowButHigh', totalScore: 3000, correctAnswers: 3, correctResponseMs: 12000, registeredAt: '2026-09-01T10:00:00Z' },
    { id: 'p2', alias: 'FastSameScore', totalScore: 2000, correctAnswers: 2, correctResponseMs: 1500, registeredAt: '2026-09-01T10:00:00Z' },
    { id: 'p3', alias: 'SlowSameScore', totalScore: 2000, correctAnswers: 2, correctResponseMs: 2500, registeredAt: '2026-09-01T10:00:00Z' },
    { id: 'p4', alias: 'MoreCorrectLowerScore', totalScore: 2000, correctAnswers: 3, correctResponseMs: 5000, registeredAt: '2026-09-01T10:00:00Z' },
    { id: 'p5', alias: 'EarlierRegistered', totalScore: 2000, correctAnswers: 2, correctResponseMs: 1500, registeredAt: '2026-08-30T10:00:00Z' },
  ];

  const sorted = [...candidates].sort(compareRank);
  const ids = sorted.map(c => c.id);

  // Expected order:
  // 1. p1 (3000 pts)
  // 2. p4 (2000 pts, 3 correct answers)
  // 3. p5 (2000 pts, 2 correct, 1500ms, earlier registered on 2026-08-30)
  // 4. p2 (2000 pts, 2 correct, 1500ms, registered on 2026-09-01)
  // 5. p3 (2000 pts, 2 correct, 2500ms)
  assert.deepEqual(ids, ['p1', 'p4', 'p5', 'p2', 'p3']);
});

test('score calculation: Day 1 + Day 2 accumulation, decode isolation, void exclusion', () => {
  const participants = [
    { id: 'p-1', alias: 'Ada', registeredAt: '2026-09-01T08:00:00Z' },
    { id: 'p-2', alias: 'Bola', registeredAt: '2026-09-01T08:05:00Z' }
  ];

  const answers = [
    // p-1: Day 1 passport (1000), Day 2 passport (1000), Decode (3), voided passport (1000)
    { participantId: 'p-1', questionId: 'q-d1', activity: 'passport', day: 1, category: 'food', correct: true, points: 1000, responseMs: 2100 },
    { participantId: 'p-1', questionId: 'q-d2', activity: 'passport', day: 2, category: 'language', correct: true, points: 1000, responseMs: 1800 },
    { participantId: 'p-1', questionId: 'q-dec', activity: 'decode', day: 1, category: 'geography', correct: true, points: 3, responseMs: 4500 },
    { participantId: 'p-1', questionId: 'q-void', activity: 'passport', day: 1, category: 'everyday', correct: true, points: 1000, voided: true, responseMs: 1000 },

    // p-2: Day 1 passport wrong (0), Day 2 passport (1000), Decode (2)
    { participantId: 'p-2', questionId: 'q-d1', activity: 'passport', day: 1, category: 'food', correct: false, points: 0, responseMs: 3000 },
    { participantId: 'p-2', questionId: 'q-d2', activity: 'passport', day: 2, category: 'language', correct: true, points: 1000, responseMs: 1200 },
    { participantId: 'p-2', questionId: 'q-dec', activity: 'decode', day: 1, category: 'geography', correct: true, points: 2, responseMs: 2000 },
  ];

  const computed = computeScoresAndRanks({ participants, answers });

  // Check p-1 scores
  const p1 = computed.participantSnapshots.get('p-1');
  assert.equal(p1.scores.day1, 1000);
  assert.equal(p1.scores.day2, 1000);
  assert.equal(p1.scores.combined, 2000);
  assert.equal(p1.scores.decode, 3);
  assert.equal(p1.rank, 1); // Rank 1 in passport (2000 pts)
  assert.equal(p1.decodeRank, 1); // Rank 1 in decode (3 pts)

  // Check p-2 scores
  const p2 = computed.participantSnapshots.get('p-2');
  assert.equal(p2.scores.day1, 0);
  assert.equal(p2.scores.day2, 1000);
  assert.equal(p2.scores.combined, 1000);
  assert.equal(p2.scores.decode, 2);
  assert.equal(p2.rank, 2);
  assert.equal(p2.decodeRank, 2);

  // Check passport leaders Top 10
  assert.equal(computed.passportLeaders.length, 2);
  assert.equal(computed.passportLeaders[0].alias, 'Ada');
  assert.equal(computed.passportLeaders[0].totalScore, 2000);
  assert.equal(computed.passportLeaders[1].alias, 'Bola');
  assert.equal(computed.passportLeaders[1].totalScore, 1000);

  // Check decode leaders Top 10
  assert.equal(computed.decodeLeaders[0].alias, 'Ada');
  assert.equal(computed.decodeLeaders[0].totalScore, 3);
  assert.equal(computed.decodeLeaders[1].alias, 'Bola');
  assert.equal(computed.decodeLeaders[1].totalScore, 2);
});

test('cultural stamp evaluation: earned stamps from non-void passport questions', () => {
  const answers = [
    { activity: 'passport', category: 'food', correct: true, is_void: false },
    { activity: 'passport', category: 'language', correct: true, is_void: false },
    { activity: 'passport', category: 'geography', correct: false, is_void: false },
    { activity: 'passport', category: 'entertainment', correct: true, is_void: true }, // Voided: not earned
    { activity: 'decode', category: 'everyday', correct: true, is_void: false } // Decode: not passport stamp
  ];

  const stamps = stampProgress(answers);
  const foodStamp = stamps.find(s => s.category === 'food');
  const langStamp = stamps.find(s => s.category === 'language');
  const geoStamp = stamps.find(s => s.category === 'geography');
  const entStamp = stamps.find(s => s.category === 'entertainment');
  const everyStamp = stamps.find(s => s.category === 'everyday');

  assert.equal(foodStamp.earned, true);
  assert.equal(langStamp.earned, true);
  assert.equal(geoStamp.earned, false);
  assert.equal(entStamp.earned, false);
  assert.equal(everyStamp.earned, false);
});

test('reveal barrier: Stop Intake -> Drain Queue -> Reconcile -> Generate Snapshots', async () => {
  const stateTransitions = [];
  const fakeFlusher = {
    drained: false,
    async drainQueue() {
      this.drained = true;
    }
  };

  const participants = [
    { id: 'u1', alias: 'PlayerOne', registeredAt: '2026-09-01T00:00:00Z' },
    { id: 'u2', alias: 'PlayerTwo', registeredAt: '2026-09-01T00:01:00Z' }
  ];

  const rawAnswers = [
    { participantId: 'u1', questionId: 'q1', activity: 'passport', day: 1, correct: true, points: 1000, responseMs: 2000, category: 'food' },
    { participantId: 'u2', questionId: 'q1', activity: 'passport', day: 1, correct: false, points: 0, responseMs: 3000, category: 'food' }
  ];

  let persistedSnapshots = null;

  const result = await executeRevealBarrier({
    session: { id: 'test-session', version: 3, state: 'open' },
    flusher: fakeFlusher,
    acceptedCount: 2,
    getAnswersFn: async () => rawAnswers,
    getParticipantsFn: async () => participants,
    persistSnapshotsFn: async (snaps) => {
      persistedSnapshots = snaps;
    },
    onStateChangeFn: async (newState, ver) => {
      stateTransitions.push({ state: newState, version: ver });
    }
  });

  // Verify sequential lifecycle
  assert.equal(stateTransitions[0].state, 'locked'); // Step 1: Stop Intake
  assert.equal(fakeFlusher.drained, true); // Step 2: Queue Drained
  assert.equal(result.reconciliation.reconciled, true); // Step 3: Reconciled
  assert.equal(result.snapshotVersion, 4); // Step 4: Version incremented
  assert.ok(persistedSnapshots != null); // Step 5: Snapshots generated & persisted
  assert.equal(stateTransitions[1].state, 'revealed'); // Step 6: Revealed broadcast
  assert.equal(stateTransitions[1].version, 4);

  // Check persisted snapshot data structure matches Supabase schema
  assert.equal(persistedSnapshots.leaderboardSnapshots.length, 2);
  assert.equal(persistedSnapshots.leaderboardSnapshots[0].activity, 'passport');
  assert.equal(persistedSnapshots.leaderboardSnapshots[0].snapshotVersion, 4);
  assert.equal(persistedSnapshots.participantScoreSnapshots.length, 2);
  assert.equal(persistedSnapshots.participantScoreSnapshots[0].participantId, 'u1');
  assert.equal(persistedSnapshots.participantScoreSnapshots[0].rank, 1);
});

test('O(1) lookups: snapshot reads return in < 2ms without table scans', () => {
  const participants = Array.from({ length: 500 }, (_, i) => ({
    id: `p-${i}`,
    alias: `User_${i}`,
    registeredAt: new Date(1725148800000 + i * 1000).toISOString()
  }));

  const answers = participants.map((p, i) => ({
    participantId: p.id,
    questionId: 'q-perf',
    activity: 'passport',
    day: 1,
    category: 'everyday',
    correct: i % 2 === 0,
    points: i % 2 === 0 ? 1000 : 0,
    responseMs: 1000 + (i % 50) * 20
  }));

  const snapshots = generateSnapshots({
    sessionId: 'session-perf',
    snapshotVersion: 2,
    participants,
    answers
  });

  // Test O(1) participant lookup
  const t0 = performance.now();
  const pRecord = snapshots.participantSnapshotsMap.get('p-240');
  const participantLookupTime = performance.now() - t0;

  assert.ok(pRecord != null);
  assert.equal(pRecord.participantId, 'p-240');
  assert.ok(participantLookupTime < 1.0, `Participant O(1) lookup took ${participantLookupTime}ms (expected < 1ms)`);

  // Test O(1) leaderboard lookup
  const t1 = performance.now();
  const leaders = snapshots.leaderboards.passport.leaders;
  const leaderboardLookupTime = performance.now() - t1;

  assert.equal(leaders.length, 10);
  assert.ok(leaderboardLookupTime < 1.0, `Leaderboard O(1) lookup took ${leaderboardLookupTime}ms (expected < 1ms)`);
});

test('performance benchmark: 2,500 participants & 10,000 answers computed in < 200ms', () => {
  const count = 2500;
  const participants = Array.from({ length: count }, (_, i) => ({
    id: `bench-p-${i}`,
    alias: `Player_${i}`,
    registeredAt: new Date(1725148800000 + i * 500).toISOString()
  }));

  // 4 answers per participant = 10,000 answers total
  const answers = [];
  for (let i = 0; i < count; i++) {
    const pId = `bench-p-${i}`;
    answers.push(
      { participantId: pId, questionId: 'q1', activity: 'passport', day: 1, category: 'food', correct: i % 3 === 0, points: i % 3 === 0 ? 1000 : 0, responseMs: 1500 },
      { participantId: pId, questionId: 'q2', activity: 'passport', day: 2, category: 'language', correct: i % 2 === 0, points: i % 2 === 0 ? 1000 : 0, responseMs: 1800 },
      { participantId: pId, questionId: 'q3', activity: 'passport', day: 2, category: 'entertainment', correct: i % 4 === 0, points: i % 4 === 0 ? 1000 : 0, responseMs: 1200 },
      { participantId: pId, questionId: 'q4', activity: 'decode', day: 1, category: 'geography', correct: i % 5 === 0, points: i % 5 === 0 ? 3 : 0, responseMs: 2500 }
    );
  }

  const start = performance.now();
  const snapshots = generateSnapshots({
    sessionId: 'session-2500',
    snapshotVersion: 5,
    participants,
    answers
  });
  const elapsedMs = performance.now() - start;

  assert.equal(snapshots.leaderboards.passport.leaders.length, 10);
  assert.equal(snapshots.leaderboards.decode.leaders.length, 10);
  assert.equal(snapshots.participantSnapshotsMap.size, count);
  assert.equal(snapshots.participantScoreSnapshots.length, count);

  // Performance gate: compute all 2,500 participants & 10,000 answers in < 200ms (SLA is < 3000ms)
  assert.ok(
    elapsedMs < 200,
    `2,500-player scoring took ${elapsedMs.toFixed(2)}ms (must be < 200ms, SLA < 3000ms)`
  );
});
