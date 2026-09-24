import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminSession, hashAdminPin } from '../server/admin-auth.mjs';
import { handler as authorityHandler } from '../server/api.mjs';
import { computeScoresAndRanks, generateSnapshots, compareRank } from '../lib/snapshot-scoring.mjs';

const PIN = '58310472';
const SECRET = 'test-admin-session-secret-that-is-long-enough-123456';
const HASH = hashAdminPin(PIN, Buffer.alloc(16, 7));

function withAdminEnv(fn) {
  const beforeHash = process.env.ADMIN_PIN_HASH;
  const beforeSecret = process.env.ADMIN_SESSION_SECRET;
  const beforeUrl = process.env.SUPABASE_URL;
  const beforeKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.ADMIN_PIN_HASH = HASH;
  process.env.ADMIN_SESSION_SECRET = SECRET;
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://db.example';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-key';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (beforeHash === undefined) delete process.env.ADMIN_PIN_HASH;
      else process.env.ADMIN_PIN_HASH = beforeHash;
      if (beforeSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
      else process.env.ADMIN_SESSION_SECRET = beforeSecret;
      if (beforeUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = beforeUrl;
      if (beforeKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = beforeKey;
    });
}

test('Manage Words: new submissions remain pending and stay off public map until approved', async () => {
  await withAdminEnv(async () => {
    let insertedSubmission = null;
    const originalFetch = global.fetch;

    global.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('/participants?token_hash=eq.')) {
        return new Response(JSON.stringify([{ id: 'player-test-1', alias: 'Chidi', event_id: 'test-event-id' }]), { status: 200 });
      }
      if (urlStr.includes('/events')) {
        return new Response(JSON.stringify([{ id: 'test-event-id' }]), { status: 200 });
      }
      if (urlStr.includes('/lens_submissions') && options.method === 'POST') {
        insertedSubmission = JSON.parse(options.body);
        return new Response(JSON.stringify([{ id: 'lens-new-1', ...insertedSubmission }]), { status: 201 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      const submitRes = await authorityHandler({
        httpMethod: 'POST',
        path: '/api/lens',
        headers: { authorization: 'Bearer test-player-token' },
        body: JSON.stringify({ phrase: 'Innovation' })
      });

      assert.equal(submitRes.statusCode, 200);
      assert.ok(insertedSubmission, 'Submission must be posted to db');
      assert.equal(insertedSubmission.phrase, 'Innovation');
      assert.equal(insertedSubmission.status, 'pending', 'New submission must default to pending');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('Manage Words lifecycle: pending -> approved -> hidden -> restored with server-backed read path enforcement', async () => {
  await withAdminEnv(async () => {
    const adminToken = createAdminSession();
    const originalFetch = global.fetch;

    // Database mock backing store
    const dbSubmissions = [
      {
        id: 'lens-test-101',
        event_id: 'test-event-id',
        participant_id: 'player-test-1',
        phrase: 'Unity in Diversity',
        normalized_phrase: 'unity in diversity',
        status: 'pending',
        created_at: '2026-09-24T10:00:00Z',
        participants: { alias: 'Chidi' }
      }
    ];

    global.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('/events')) {
        return new Response(JSON.stringify([{ id: 'test-event-id' }]), { status: 200 });
      }
      if (urlStr.includes('/admin_audit_logs')) {
        return new Response(JSON.stringify([{ id: 'audit-1' }]), { status: 200 });
      }

      // Public approved query: status=eq.approved
      if (urlStr.includes('/lens_submissions?event_id=eq.') && urlStr.includes('status=eq.approved')) {
        const approved = dbSubmissions.filter(s => s.status === 'approved');
        return new Response(JSON.stringify(approved), { status: 200 });
      }

      // Admin query: returns all statuses
      if (urlStr.includes('/lens_submissions?event_id=eq.') && urlStr.includes('select=id,phrase,created_at,status')) {
        return new Response(JSON.stringify(dbSubmissions), { status: 200 });
      }

      // Single item select for moderation
      if (urlStr.includes('/lens_submissions?id=eq.') && (!options.method || options.method === 'GET')) {
        const idMatch = urlStr.match(/id=eq\.([^&]+)/);
        const id = idMatch ? decodeURIComponent(idMatch[1]) : null;
        const item = dbSubmissions.find(s => s.id === id);
        return new Response(JSON.stringify(item ? [item] : []), { status: 200 });
      }

      // Moderation PATCH: preserve record, update status/reviewed_at
      if (urlStr.includes('/lens_submissions?id=eq.') && options.method === 'PATCH') {
        const idMatch = urlStr.match(/id=eq\.([^&]+)/);
        const id = idMatch ? decodeURIComponent(idMatch[1]) : null;
        const item = dbSubmissions.find(s => s.id === id);
        if (!item) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        const patch = JSON.parse(options.body);
        Object.assign(item, patch);
        return new Response(JSON.stringify([item]), { status: 200 });
      }

      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      // 1. Initial State: submission is pending
      // Public read path must NOT show pending words
      const pub1 = await authorityHandler({ httpMethod: 'GET', path: '/api/lens/approved' });
      assert.equal(pub1.statusCode, 200);
      const pubBody1 = JSON.parse(pub1.body);
      assert.equal(pubBody1.responses.length, 0, 'Pending submission must NOT appear on public map');

      // Admin read path MUST show pending words
      const admin1 = await authorityHandler({
        httpMethod: 'GET',
        path: '/api/admin/lens',
        headers: { authorization: `Bearer ${adminToken}` }
      });
      assert.equal(admin1.statusCode, 200);
      const adminBody1 = JSON.parse(admin1.body);
      assert.equal(adminBody1.responses.length, 1);
      assert.equal(adminBody1.responses[0].status, 'pending');
      assert.equal(adminBody1.responses[0].phrase, 'Unity in Diversity');

      // 2. Admin Approves submission
      const approveRes = await authorityHandler({
        httpMethod: 'POST',
        path: '/api/admin/action',
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ kind: 'moderate', id: 'lens-test-101', status: 'approved' })
      });
      assert.equal(approveRes.statusCode, 200);
      assert.equal(JSON.parse(approveRes.body).response.status, 'approved');

      // Public read path MUST now show approved word
      const pub2 = await authorityHandler({ httpMethod: 'GET', path: '/api/lens/approved' });
      assert.equal(pub2.statusCode, 200);
      const pubBody2 = JSON.parse(pub2.body);
      assert.equal(pubBody2.responses.length, 1, 'Approved submission must appear on public map');
      assert.equal(pubBody2.responses[0].phrase, 'Unity in Diversity');

      // 3. Admin Hides word from map
      const hideRes = await authorityHandler({
        httpMethod: 'POST',
        path: '/api/admin/action',
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ kind: 'moderate', id: 'lens-test-101', status: 'hidden' })
      });
      assert.equal(hideRes.statusCode, 200);
      assert.equal(JSON.parse(hideRes.body).response.status, 'hidden');

      // Public read path must NOT show hidden word
      const pub3 = await authorityHandler({ httpMethod: 'GET', path: '/api/lens/approved' });
      assert.equal(pub3.statusCode, 200);
      const pubBody3 = JSON.parse(pub3.body);
      assert.equal(pubBody3.responses.length, 0, 'Hidden submission must be excluded from public map');

      // Submission is preserved (NOT deleted) in admin query
      const admin2 = await authorityHandler({
        httpMethod: 'GET',
        path: '/api/admin/lens',
        headers: { authorization: `Bearer ${adminToken}` }
      });
      assert.equal(admin2.statusCode, 200);
      const adminBody2 = JSON.parse(admin2.body);
      assert.equal(adminBody2.responses.length, 1, 'Hidden submission must be preserved in database');
      assert.equal(adminBody2.responses[0].status, 'hidden');

      // 4. Admin Restores hidden word
      const restoreRes = await authorityHandler({
        httpMethod: 'POST',
        path: '/api/admin/action',
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ kind: 'moderate', id: 'lens-test-101', status: 'approved' })
      });
      assert.equal(restoreRes.statusCode, 200);
      assert.equal(JSON.parse(restoreRes.body).response.status, 'approved');

      // Public read path MUST show restored word again
      const pub4 = await authorityHandler({ httpMethod: 'GET', path: '/api/lens/approved' });
      assert.equal(pub4.statusCode, 200);
      const pubBody4 = JSON.parse(pub4.body);
      assert.equal(pubBody4.responses.length, 1, 'Restored submission must reappear on public map');
      assert.equal(pubBody4.responses[0].phrase, 'Unity in Diversity');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('Decode scoring and cumulative event total: adds Passport and Decode points together', () => {
  const participants = [
    { id: 'p1', alias: 'Kelechi', registeredAt: '2026-09-01T08:00:00Z', isSpectator: false },
    { id: 'p2', alias: 'Ngozi', registeredAt: '2026-09-01T08:01:00Z', isSpectator: false },
    { id: 'p3', alias: 'Tari', registeredAt: '2026-09-01T08:02:00Z', isSpectator: false }
  ];

  const answers = [
    // Passport Day 1 (1000 pts)
    { participantId: 'p1', questionId: 'q-pass-1', activity: 'passport', day: 1, category: 'food', correct: true, points: 1000, responseMs: 2500 },
    { participantId: 'p2', questionId: 'q-pass-1', activity: 'passport', day: 1, category: 'food', correct: true, points: 1000, responseMs: 3500 },
    { participantId: 'p3', questionId: 'q-pass-1', activity: 'passport', day: 1, category: 'food', correct: false, points: 0, responseMs: 2000 },

    // Decode Question (1000 pts)
    { participantId: 'p1', questionId: 'q-dec-1', activity: 'decode', day: 1, category: 'geography', correct: true, points: 1000, responseMs: 4000 },
    { participantId: 'p2', questionId: 'q-dec-1', activity: 'decode', day: 1, category: 'geography', correct: false, points: 0, responseMs: 5000 },
    { participantId: 'p3', questionId: 'q-dec-1', activity: 'decode', day: 1, category: 'geography', correct: true, points: 1000, responseMs: 3000 }
  ];

  const { leaderboards, participantSnapshotsMap } = generateSnapshots({
    sessionId: 'session-live',
    snapshotVersion: 2,
    participants,
    answers
  });

  const p1 = participantSnapshotsMap.get('p1');
  const p2 = participantSnapshotsMap.get('p2');
  const p3 = participantSnapshotsMap.get('p3');

  // Kelechi: 1000 Passport + 1000 Decode = 2000 Event Total
  assert.equal(p1.scores.day1, 1000);
  assert.equal(p1.scores.combined, 1000);
  assert.equal(p1.scores.decode, 1000);
  assert.equal(p1.scores.total, 2000, 'Cumulative event total must combine Passport + Decode');
  assert.equal(p1.rank, 1, 'Kelechi with 2,000 total points ranks #1');

  // Ngozi: 1000 Passport + 0 Decode = 1000 Event Total (3500ms correct time)
  assert.equal(p2.scores.total, 1000);

  // Tari: 0 Passport + 1000 Decode = 1000 Event Total (3000ms correct time - faster than Ngozi)
  assert.equal(p3.scores.total, 1000);

  // Check event leaders Top 10
  const leaders = leaderboards.passport.leaders;
  assert.equal(leaders[0].alias, 'Kelechi');
  assert.equal(leaders[0].totalScore, 2000, 'Leaderboard displays cumulative event total');
  assert.equal(leaders[0].rank, 1);

  // Tari and Ngozi tie on points (1000), but Tari answered in 3000ms vs Ngozi 3500ms -> Tari ranks #2
  assert.equal(leaders[1].alias, 'Tari');
  assert.equal(leaders[1].totalScore, 1000);
  assert.equal(leaders[2].alias, 'Ngozi');
  assert.equal(leaders[2].totalScore, 1000);

  // Participant score and leaderboard agree after reveal
  assert.equal(p1.scores.total, leaders[0].totalScore);
  assert.equal(p1.rank, leaders[0].rank);
});

test('Duplicate answer protection: duplicate submissions never award points twice', () => {
  const participants = [
    { id: 'p1', alias: 'Zainab', registeredAt: '2026-09-01T08:00:00Z', isSpectator: false }
  ];

  const answers = [
    // Original answer
    { participantId: 'p1', questionId: 'q-1', activity: 'passport', day: 1, category: 'food', correct: true, points: 1000, responseMs: 2000 },
    // Duplicate submission (e.g. retry / client replay)
    { participantId: 'p1', questionId: 'q-1', activity: 'passport', day: 1, category: 'food', correct: true, points: 1000, responseMs: 2100, duplicate: true },
    // Duplicate submission without explicit flag
    { participantId: 'p1', questionId: 'q-1', activity: 'passport', day: 1, category: 'food', correct: true, points: 1000, responseMs: 2200 }
  ];

  const computed = computeScoresAndRanks({ participants, answers });
  const p1 = computed.participantSnapshots.get('p1');

  // Must only count first submission once -> exactly 1000 points, never 2000 or 3000
  assert.equal(p1.scores.day1, 1000);
  assert.equal(p1.scores.total, 1000, 'Duplicate answers must NEVER award points twice');
  assert.equal(p1.scores.combined, 1000);
});

test('Void exclusions and spectator exclusions preserved in cumulative scoring', () => {
  const participants = [
    { id: 'p1', alias: 'PlayerActive', registeredAt: '2026-09-01T08:00:00Z', isSpectator: false },
    { id: 'p2', alias: 'PlayerSpectator', registeredAt: '2026-09-01T08:01:00Z', isSpectator: true },
    { id: 'p3', alias: 'PlayerRehearsal', registeredAt: '2026-09-01T08:02:00Z', isRehearsal: true }
  ];

  const answers = [
    // Voided question
    { participantId: 'p1', questionId: 'q-void', activity: 'passport', day: 1, category: 'food', correct: true, points: 1000, voided: true, responseMs: 1500 },
    // Valid passport
    { participantId: 'p1', questionId: 'q-pass', activity: 'passport', day: 1, category: 'language', correct: true, points: 1000, responseMs: 2000 },
    // Valid decode
    { participantId: 'p1', questionId: 'q-dec', activity: 'decode', day: 1, category: 'geography', correct: true, points: 1000, responseMs: 2500 },

    // Spectator answers
    { participantId: 'p2', questionId: 'q-pass', activity: 'passport', day: 1, category: 'language', correct: true, points: 1000, responseMs: 1200 },

    // Rehearsal player answers
    { participantId: 'p3', questionId: 'q-pass', activity: 'passport', day: 1, category: 'language', correct: true, points: 1000, responseMs: 1100 }
  ];

  const { leaderboards, participantSnapshotsMap } = generateSnapshots({
    sessionId: 'session-exclusions',
    snapshotVersion: 1,
    participants,
    answers
  });

  const p1 = participantSnapshotsMap.get('p1');
  const p2 = participantSnapshotsMap.get('p2');
  const p3 = participantSnapshotsMap.get('p3');

  // Voided question points (1000) are excluded: score is 1000 (passport) + 1000 (decode) = 2000
  assert.equal(p1.scores.total, 2000, 'Voided questions must be excluded from cumulative event total');
  assert.equal(p1.rank, 1);

  // Spectators and rehearsal players excluded from competitive rankings
  assert.equal(p2.rank, null, 'Spectators must have null rank');
  assert.equal(p3.rank, null, 'Rehearsal players must have null rank');

  // Leaderboard must NOT include spectator or rehearsal players
  const leaders = leaderboards.passport.leaders;
  assert.equal(leaders.length, 1);
  assert.equal(leaders[0].alias, 'PlayerActive');
  assert.ok(!leaders.some(l => l.alias === 'PlayerSpectator' || l.alias === 'PlayerRehearsal'));
});

test('Participant join: rejects duplicate alias case-insensitively and allows same-device recognition', async () => {
  await withAdminEnv(async () => {
    const originalFetch = global.fetch;
    const existingToken = 'my-existing-secret-token';
    const crypto = await import('node:crypto');
    const tokenHash = crypto.createHash('sha256').update(`${process.env.PARTICIPANT_TOKEN_PEPPER || ''}:${existingToken}`).digest('hex');

    global.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('/events')) {
        return new Response(JSON.stringify([{ id: 'test-event-id' }]), { status: 200 });
      }
      if (urlStr.includes('/event_settings')) {
        return new Response(JSON.stringify([{ event_id: 'test-event-id' }]), { status: 200 });
      }
      if (urlStr.includes('/participants?') && urlStr.includes('alias=ilike.')) {
        if (urlStr.includes('Ada') || urlStr.includes('ada')) {
          return new Response(JSON.stringify([{
            id: 'p-ada-1',
            alias: 'Ada',
            token_hash: tokenHash,
            is_spectator: false,
            is_rehearsal: false
          }]), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (urlStr.includes('/participants') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return new Response(JSON.stringify([{ id: 'p-new-1', ...body }]), { status: 201 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      // 1. Attempt to join with taken alias without bearer token -> 409
      const dupRes = await authorityHandler({
        httpMethod: 'POST',
        path: '/api/participants',
        headers: {},
        body: JSON.stringify({ alias: 'ada' })
      });
      assert.equal(dupRes.statusCode, 409);
      const dupBody = JSON.parse(dupRes.body);
      assert.match(dupBody.error, /already taken/i);

      // 2. Same device re-submitting with matching bearer token -> 200 OK
      const sameDeviceRes = await authorityHandler({
        httpMethod: 'POST',
        path: '/api/participants',
        headers: { authorization: `Bearer ${existingToken}` },
        body: JSON.stringify({ alias: 'Ada' })
      });
      assert.equal(sameDeviceRes.statusCode, 200);
      const sameDeviceBody = JSON.parse(sameDeviceRes.body);
      assert.equal(sameDeviceBody.participant.id, 'p-ada-1');
      assert.equal(sameDeviceBody.participant.alias, 'Ada');

      // 3. New unique alias -> 200 OK
      const newRes = await authorityHandler({
        httpMethod: 'POST',
        path: '/api/participants',
        headers: {},
        body: JSON.stringify({ alias: 'BrandNewPlayer' })
      });
      assert.equal(newRes.statusCode, 200);
      const newBody = JSON.parse(newRes.body);
      assert.equal(newBody.participant.alias, 'BrandNewPlayer');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

