import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAdminSession, hashAdminPin, verifyAdminPin, verifyAdminSession } from '../server/admin-auth.mjs';
import { handler as authorityHandler } from '../server/api.mjs';

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

test('admin PIN hash verifies only the exact 8-digit code', async () => {
  await withAdminEnv(() => {
    assert.equal(verifyAdminPin(PIN), true);
    assert.equal(verifyAdminPin('58310473'), false);
    assert.equal(verifyAdminPin('19601960'), false);
    assert.equal(verifyAdminPin('1234'), false);
  });
});

test('admin session is signed, expires, and rejects tampering', async () => {
  await withAdminEnv(() => {
    const now = Date.UTC(2026, 8, 21, 12, 0, 0);
    const token = createAdminSession(now);
    const admin = verifyAdminSession(`Bearer ${token}`, now + 1000);

    assert.equal(admin.admin.display_name, 'Event Team');
    assert.equal(admin.role, 'operator');
    assert.equal(admin.id, null);

    assert.throws(
      () => verifyAdminSession(`Bearer ${token}x`, now + 1000),
      error => error.status === 401
    );

    assert.throws(
      () => verifyAdminSession(`Bearer ${token}`, now + (8 * 60 * 60 * 1000) + 1000),
      error => error.status === 401
    );
  });
});

test('POST /api/admin/login issues a session for a valid PIN', async () => {
  await withAdminEnv(async () => {
    const result = await authorityHandler({
      httpMethod: 'POST',
      path: '/api/admin/login',
      headers: { 'x-real-ip': '203.0.113.10' },
      body: JSON.stringify({ pin: PIN })
    });

    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.ok(body.token);
    assert.equal(body.expiresInSeconds, 8 * 60 * 60);
    assert.equal(body.admin.displayName, 'Event Team');
    assert.equal(verifyAdminSession(`Bearer ${body.token}`).role, 'operator');
  });
});

test('POST /api/admin/login rejects an incorrect PIN without exposing details', async () => {
  await withAdminEnv(async () => {
    const result = await authorityHandler({
      httpMethod: 'POST',
      path: '/api/admin/login',
      headers: { 'x-real-ip': '203.0.113.11' },
      body: JSON.stringify({ pin: '11111111' })
    });

    assert.equal(result.statusCode, 401);
    assert.deepEqual(JSON.parse(result.body), { error: 'Invalid control code.' });
  });
});

test('admin status reads answer options from question_options, not a nonexistent quiz_questions.options column', () => {
  const source = fs.readFileSync(new URL('../server/api.mjs', import.meta.url), 'utf8');
  assert.match(source, /question_options\(option_index,label\)/);
  assert.doesNotMatch(source, /quiz_questions\?select=[^'\n]*\boptions\b/);
});

test('admin action show_welcome sets screen_mode to welcome and resets session to lobby without error', async () => {
  await withAdminEnv(async () => {
    const token = createAdminSession();
    const originalFetch = global.fetch;
    const patchedEvents = [];

    global.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('/events')) {
        return new Response(JSON.stringify([{ id: 'test-event-id' }]), { status: 200 });
      }
      if (urlStr.includes('/live_sessions?event_id=eq.')) {
        return new Response(JSON.stringify([{
          id: 'test-session-id',
          event_id: 'test-event-id',
          state: 'revealed',
          current_question_id: 'q-1',
          version: 10
        }]), { status: 200 });
      }
      if (options.method === 'PATCH' && urlStr.includes('/event_settings?event_id=eq.')) {
        const body = JSON.parse(options.body);
        patchedEvents.push({ type: 'settings', body });
        return new Response(JSON.stringify([{ screen_mode: body.screen_mode }]), { status: 200 });
      }
      if (options.method === 'PATCH' && urlStr.includes('/live_sessions?id=eq.')) {
        const body = JSON.parse(options.body);
        patchedEvents.push({ type: 'session', body });
        return new Response(JSON.stringify([{ state: body.state, version: body.version }]), { status: 200 });
      }
      if (options.method === 'POST' && urlStr.includes('/admin_audit_logs')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      const result = await authorityHandler({
        httpMethod: 'POST',
        path: '/api/admin/action',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind: 'show_welcome' })
      });

      assert.equal(result.statusCode, 200, `Expected 200, got ${result.statusCode}: ${result.body}`);
      const body = JSON.parse(result.body);
      assert.equal(body.session.state, 'lobby');
      assert.ok(patchedEvents.some(e => e.type === 'settings' && e.body.screen_mode === 'welcome'));
      assert.ok(patchedEvents.some(e => e.type === 'session' && e.body.state === 'lobby'));
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('admin action set_settings switches activity, sets screen_mode to activity and resets session to lobby', async () => {
  await withAdminEnv(async () => {
    const token = createAdminSession();
    const originalFetch = global.fetch;
    const patchedEvents = [];

    global.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('/events')) {
        return new Response(JSON.stringify([{ id: 'test-event-id' }]), { status: 200 });
      }
      if (urlStr.includes('/event_settings?event_id=eq.')) {
        if (options.method === 'PATCH') {
          const body = JSON.parse(options.body);
          patchedEvents.push({ type: 'settings', body });
          return new Response(JSON.stringify([{ active_activity: body.active_activity, screen_mode: body.screen_mode }]), { status: 200 });
        }
        return new Response(JSON.stringify([{ active_activity: 'passport', screen_mode: 'welcome' }]), { status: 200 });
      }
      if (urlStr.includes('/live_sessions?event_id=eq.')) {
        return new Response(JSON.stringify([{
          id: 'test-session-id',
          event_id: 'test-event-id',
          state: 'revealed',
          current_question_id: 'q-passport',
          version: 12
        }]), { status: 200 });
      }
      if (options.method === 'PATCH' && urlStr.includes('/live_sessions?id=eq.')) {
        const body = JSON.parse(options.body);
        patchedEvents.push({ type: 'session', body });
        return new Response(JSON.stringify([{ state: body.state, version: body.version }]), { status: 200 });
      }
      if (options.method === 'POST' && urlStr.includes('/admin_audit_logs')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      const result = await authorityHandler({
        httpMethod: 'POST',
        path: '/api/admin/action',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind: 'set_settings', activeActivity: 'decode', rehearsalMode: false })
      });

      assert.equal(result.statusCode, 200, `Expected 200, got ${result.statusCode}: ${result.body}`);
      assert.ok(patchedEvents.some(e => e.type === 'settings' && e.body.active_activity === 'decode' && e.body.screen_mode === 'activity'));
      assert.ok(patchedEvents.some(e => e.type === 'session' && e.body.state === 'lobby'));
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('GET /api/admin/lens returns moderation responses array for authenticated admin', async () => {
  await withAdminEnv(async () => {
    const token = createAdminSession();
    const originalFetch = global.fetch;

    global.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/events')) {
        return new Response(JSON.stringify([{ id: 'test-event-id' }]), { status: 200 });
      }
      if (urlStr.includes('/lens_submissions?event_id=eq.')) {
        return new Response(JSON.stringify([
          { id: 'lens-1', phrase: 'Unity', created_at: '2026-09-21T12:00:00Z', status: 'approved', participants: { alias: 'Amaka' } },
          { id: 'lens-2', phrase: 'Hope', created_at: '2026-09-21T12:01:00Z', status: 'hidden', participants: null }
        ]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      const result = await authorityHandler({
        httpMethod: 'GET',
        path: '/api/admin/lens',
        headers: { authorization: `Bearer ${token}` }
      });

      assert.equal(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.ok(Array.isArray(body.responses));
      assert.equal(body.responses.length, 2);
      assert.equal(body.responses[0].phrase, 'Unity');
      assert.equal(body.responses[0].participants?.alias, 'Amaka');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('GET /api/lens/approved returns responses and items without SQL errors', async () => {
  await withAdminEnv(async () => {
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/events')) {
        return new Response(JSON.stringify([{ id: 'test-event-id' }]), { status: 200 });
      }
      if (urlStr.includes('/lens_submissions?event_id=eq.')) {
        assert.match(urlStr, /phrase/);
        assert.doesNotMatch(urlStr, /moderated_response/);
        return new Response(JSON.stringify([
          { id: 'lens-1', phrase: 'Resilience', normalized_phrase: 'resilience', created_at: '2026-09-21T12:00:00Z' }
        ]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      const result = await authorityHandler({
        httpMethod: 'GET',
        path: '/api/lens/approved'
      });

      assert.equal(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.ok(Array.isArray(body.responses));
      assert.equal(body.responses[0].phrase, 'Resilience');
      assert.ok(Array.isArray(body.items));
      assert.equal(body.items[0].response, 'Resilience');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('clean event cycle: Welcome -> Passport -> open -> reveal -> Top 10 -> next Q -> Decode -> clues -> voting -> reveal -> Welcome -> Lens -> Passport', async () => {
  await withAdminEnv(async () => {
    const token = createAdminSession();
    const originalFetch = global.fetch;
    let trackDecodeOpenAction = false;
    let responseCounterReadyAt = 0;
    let openSessionPatch = null;
    const decodeOpenTimeline = [];

    const mockSettings = {
      event_id: 'ev-1',
      active_activity: 'passport',
      screen_mode: 'welcome',
      rehearsal_mode: false,
      roster_frozen: false
    };

    const mockSession = {
      id: 'sess-1',
      event_id: 'ev-1',
      state: 'lobby',
      current_question_id: null,
      current_round_id: null,
      current_clue: 1,
      opened_at: null,
      deadline_at: null,
      version: 1
    };

    const mockQuestions = {
      'q-p1': {
        id: 'q-p1',
        round_id: 'rnd-p',
        display_order: 1,
        category: 'Geography',
        question: 'What is the longest river in Nigeria?',
        correct_option: 0,
        duration_seconds: 20,
        explanation: 'River Niger is 4,180km long.',
        source: 'Federal Ministry of Water Resources',
        review_status: 'approved',
        is_void: false,
        quiz_rounds: { quiz_games: { activity: 'passport' } }
      },
      'q-p2': {
        id: 'q-p2',
        round_id: 'rnd-p',
        display_order: 2,
        category: 'History',
        question: 'In what year was Abuja officially declared Nigeria’s capital?',
        correct_option: 1,
        duration_seconds: 20,
        explanation: 'Abuja officially replaced Lagos on 12 December 1991.',
        source: 'Federal Capital Development Authority',
        review_status: 'approved',
        is_void: false,
        quiz_rounds: { quiz_games: { activity: 'passport' } }
      },
      'q-d1': {
        id: 'q-d1',
        round_id: 'rnd-d',
        display_order: 1,
        category: 'North Central',
        question: 'Which Nigerian state do these clues describe?',
        correct_option: 2,
        duration_seconds: 30,
        explanation: 'Plateau State is known as the Home of Peace and Tourism.',
        source: 'Plateau State Ministry of Tourism',
        review_status: 'approved',
        is_void: false,
        quiz_rounds: { quiz_games: { activity: 'decode' } }
      }
    };

    const mockOptions = {
      'q-p1': [
        { option_index: 0, label: 'River Niger' },
        { option_index: 1, label: 'River Benue' },
        { option_index: 2, label: 'Cross River' },
        { option_index: 3, label: 'Kaduna River' }
      ],
      'q-p2': [
        { option_index: 0, label: '1976' },
        { option_index: 1, label: '1991' },
        { option_index: 2, label: '1999' },
        { option_index: 3, label: '1985' }
      ],
      'q-d1': [
        { option_index: 0, label: 'Benue' },
        { option_index: 1, label: 'Nasarawa' },
        { option_index: 2, label: 'Plateau' },
        { option_index: 3, label: 'Kogi' }
      ]
    };

    global.fetch = async (url, options = {}) => {
      const urlStr = String(url);

      if (urlStr.includes('/events')) {
        return new Response(JSON.stringify([{ id: 'ev-1', slug: 'niac-2026' }]), { status: 200 });
      }

      if (urlStr.includes('/event_settings')) {
        if (options.method === 'PATCH') {
          Object.assign(mockSettings, JSON.parse(options.body));
          return new Response(JSON.stringify([mockSettings]), { status: 200 });
        }
        return new Response(JSON.stringify([mockSettings]), { status: 200 });
      }

      if (urlStr.includes('/live_sessions')) {
        if (options.method === 'PATCH') {
          const patch = JSON.parse(options.body);
          if (trackDecodeOpenAction && patch.state === 'open') {
            decodeOpenTimeline.push('open-session');
            openSessionPatch = patch;
          }
          Object.assign(mockSession, patch);
          return new Response(JSON.stringify([mockSession]), { status: 200 });
        }
        return new Response(JSON.stringify([mockSession]), { status: 200 });
      }

      if (urlStr.includes('/quiz_questions')) {
        const match = urlStr.match(/id=eq\.([^&]+)/);
        if (match) {
          const q = mockQuestions[match[1]];
          return new Response(JSON.stringify(q ? [q] : []), { status: 200 });
        }
        return new Response(JSON.stringify(Object.values(mockQuestions)), { status: 200 });
      }

      if (urlStr.includes('/question_options')) {
        const match = urlStr.match(/question_id=eq\.([^&]+)/);
        if (match) {
          return new Response(JSON.stringify(mockOptions[match[1]] || []), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }

      if (urlStr.includes('/quiz_rounds')) {
        const match = urlStr.match(/id=eq\.([^&]+)/);
        const roundId = match ? match[1] : '';
        const isDecode = roundId === 'rnd-d';
        return new Response(JSON.stringify([{
          id: roundId,
          day: 1,
          game_id: isDecode ? 'game-d' : 'game-p'
        }]), { status: 200 });
      }

      if (urlStr.includes('/quiz_games')) {
        const match = urlStr.match(/id=eq\.([^&]+)/);
        const gameId = match ? match[1] : '';
        const isDecode = gameId === 'game-d';
        return new Response(JSON.stringify([{
          id: gameId,
          activity: isDecode ? 'decode' : 'passport',
          title: isDecode ? 'Decode the State' : 'Naija Passport Challenge'
        }]), { status: 200 });
      }

      if (urlStr.includes('/decode_state_rounds')) {
        return new Response(JSON.stringify([{
          clues: [
            'Known as the Home of Peace and Tourism.',
            'Famous for the Shere Hills and Kurra Falls.',
            'Capital is Jos, located on an elevated plateau.'
          ],
          clue_media: null,
          state_geo_id: 'plateau',
          reveal_fact: 'Plateau State has the highest altitude in Nigeria.'
        }]), { status: 200 });
      }

      if (urlStr.includes('/live_question_state')) {
        if (trackDecodeOpenAction && options.method === 'POST') {
          responseCounterReadyAt = Date.now();
          decodeOpenTimeline.push('response-counter-ready');
        }
        return new Response(JSON.stringify([{ response_count: 0 }]), { status: 200 });
      }

      if (urlStr.includes('/leaderboard_snapshots')) {
        return new Response(JSON.stringify([{ leaders: [] }]), { status: 200 });
      }

      if (options.method === 'POST' && urlStr.includes('/admin_audit_logs')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response(JSON.stringify([]), { status: 200 });
    };

    const action = async (body) => {
      trackDecodeOpenAction = body.kind === 'open_question' && body.questionId === 'q-d1';
      if (trackDecodeOpenAction) {
        decodeOpenTimeline.length = 0;
        responseCounterReadyAt = 0;
        openSessionPatch = null;
      }
      try {
        const res = await authorityHandler({
          httpMethod: 'POST',
          path: '/api/admin/action',
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify(body)
        });
        assert.equal(res.statusCode, 200, `Action failed for ${JSON.stringify(body)}: ${res.body}`);
        return JSON.parse(res.body);
      } finally {
        trackDecodeOpenAction = false;
      }
    };

    const getState = async () => {
      const res = await authorityHandler({ httpMethod: 'GET', path: '/api/state' });
      assert.equal(res.statusCode, 200);
      return JSON.parse(res.body);
    };

    try {
      // 1. Initial Welcome Screen
      await action({ kind: 'show_welcome' });
      let state = await getState();
      assert.equal(state.screenMode, 'welcome');
      assert.equal(state.state, 'lobby');

      // 2. Switch to Passport
      await action({ kind: 'set_settings', activeActivity: 'passport', rehearsalMode: false });
      state = await getState();
      assert.equal(state.screenMode, 'activity');
      assert.equal(state.activity, 'passport');
      assert.equal(state.state, 'lobby');

      // 3. Open first Passport question
      await action({ kind: 'open_question', questionId: 'q-p1' });
      state = await getState();
      assert.equal(state.state, 'open');
      assert.equal(state.question.id, 'q-p1');
      assert.equal(state.question.options.length, 4);

      // 4. Lock & Reveal
      await action({ state: 'locked' });
      state = await getState();
      assert.equal(state.state, 'locked');

      await action({ state: 'revealed' });
      state = await getState();
      assert.equal(state.state, 'revealed');
      assert.equal(state.question.correctOption, 0);

      // 5. Show Top 10
      await action({ state: 'leaderboard' });
      state = await getState();
      assert.equal(state.state, 'leaderboard');

      // 6. Open next Passport question
      await action({ kind: 'open_question', questionId: 'q-p2' });
      state = await getState();
      assert.equal(state.state, 'open');
      assert.equal(state.question.id, 'q-p2');

      // Reveal second question
      await action({ state: 'locked' });
      await action({ state: 'revealed' });

      // 7. Switch to Decode the State (from revealed state!)
      await action({ kind: 'set_settings', activeActivity: 'decode', rehearsalMode: false });
      state = await getState();
      assert.equal(state.screenMode, 'activity');
      assert.equal(state.activity, 'decode');
      assert.equal(state.state, 'lobby');

      // 8. Select Decode Question (preparing at Clue 1)
      await action({ kind: 'select_question', questionId: 'q-d1' });
      state = await getState();
      assert.equal(state.state, 'preparing');
      assert.equal(state.activity, 'decode');
      assert.equal(state.currentClue, 1);
      assert.match(state.question.clue, /Home of Peace and Tourism/);

      // 9. Advance Clue 1 -> Clue 2
      await action({ kind: 'next_clue' });
      state = await getState();
      assert.equal(state.currentClue, 2);
      assert.match(state.question.clue, /Shere Hills/);

      // 10. Advance Clue 2 -> Clue 3
      await action({ kind: 'next_clue' });
      state = await getState();
      assert.equal(state.currentClue, 3);
      assert.match(state.question.clue, /Capital is Jos/);

      // 11. Open voting (30s)
      await action({ kind: 'open_question', questionId: 'q-d1' });
      assert.deepEqual(decodeOpenTimeline, ['response-counter-ready', 'open-session']);
      assert.ok(Date.parse(openSessionPatch.opened_at) >= responseCounterReadyAt,
        'Answer-counter preparation must finish before the answer clock starts');
      assert.equal(Date.parse(openSessionPatch.deadline_at) - Date.parse(openSessionPatch.opened_at), 30_000);
      state = await getState();
      assert.equal(state.state, 'open');
      assert.equal(state.currentClue, 3);
      assert.equal(state.question.options.length, 4);

      // 12. Reveal Decode
      await action({ state: 'locked' });
      await action({ state: 'revealed' });
      state = await getState();
      assert.equal(state.state, 'revealed');
      assert.equal(state.question.options[state.question.correctOption], 'Plateau');

      // 13. Back to Welcome Screen
      await action({ kind: 'show_welcome' });
      state = await getState();
      assert.equal(state.screenMode, 'welcome');
      assert.equal(state.state, 'lobby');

      // 14. Welcome -> Live Nigeria Map
      await action({ kind: 'set_settings', activeActivity: 'lens', rehearsalMode: false });
      state = await getState();
      assert.equal(state.screenMode, 'activity');
      assert.equal(state.activity, 'lens');
      assert.equal(state.state, 'lobby');

      // 15. Live Nigeria Map -> Back to Passport
      await action({ kind: 'set_settings', activeActivity: 'passport', rehearsalMode: false });
      state = await getState();
      assert.equal(state.screenMode, 'activity');
      assert.equal(state.activity, 'passport');
      assert.equal(state.state, 'lobby');
    } finally {
      global.fetch = originalFetch;
    }
  });
});


