import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminSession } from '../server/admin-auth.mjs';
import { handler } from '../server/api.mjs';

test('deadline reveals after drain without waiting for scoring, then gates leaderboard until snapshots finish', async () => {
  const envNames = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'PUBLIC_GATEWAY_URL', 'GATEWAY_ADMIN_SECRET', 'ADMIN_SESSION_SECRET'];
  const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const originalFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://database.example';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  process.env.PUBLIC_GATEWAY_URL = 'https://gateway.example';
  process.env.GATEWAY_ADMIN_SECRET = 'gateway-secret';
  process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-that-is-long-enough';

  const timeline = [];
  const session = {
    id: 'test-session', event_id: 'test-event', current_question_id: 'test-question',
    current_round_id: 'test-round', current_clue: 1, state: 'open', version: 1,
    deadline_at: new Date(Date.now() - 1000).toISOString()
  };
  let snapshotsReady = false;
  let snapshotWrites = 0;
  let failFirstScoreWrite = true;
  const respond = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/gateway/lock-and-drain')) {
      assert.equal(JSON.parse(options.body).state, 'locked');
      timeline.push('drain');
      return respond({ drained: true, queueDepth: 0 });
    }
    if (target.includes('/gateway/broadcast')) {
      const state = JSON.parse(options.body).state;
      assert.ok(['revealed', 'leaderboard'].includes(state));
      timeline.push(state === 'revealed' ? 'broadcast' : 'leaderboard-broadcast');
      return respond({ broadcast: true });
    }
    if (target.includes('/rest/v1/events?')) return respond([{ id: 'test-event', slug: 'niac-2026' }]);
    if (target.includes('/rest/v1/event_settings?')) return respond([{ active_activity: 'passport', screen_mode: 'activity' }]);
    if (target.includes('/rest/v1/live_sessions?')) {
      if (options.method === 'PATCH') {
        Object.assign(session, JSON.parse(options.body));
        timeline.push(session.state === 'locked' ? 'locked' : session.state === 'revealed' ? 'persist' : session.state);
      }
      return respond([session]);
    }
    if (target.includes('/rest/v1/quiz_questions?')) {
      return respond([{ id: 'test-question', round_id: 'test-round', question: 'Test?', category: 'Food',
        correct_option: 0, is_void: false, duration_seconds: 20,
        quiz_rounds: { day: 1, quiz_games: { activity: 'passport' } } }]);
    }
    if (target.includes('/rest/v1/question_options?')) return respond([{ option_index: 0, label: 'A' }, { option_index: 1, label: 'B' }]);
    if (target.includes('/rest/v1/quiz_rounds?')) return respond([{ id: 'test-round', day: 1, game_id: 'test-game' }]);
    if (target.includes('/rest/v1/quiz_games?')) return respond([{ id: 'test-game', activity: 'passport', title: 'Passport' }]);
    if (target.includes('/rest/v1/live_question_state?')) return respond([{ response_count: 1 }]);
    if (target.includes('/rest/v1/leaderboard_snapshots?')) {
      if (options.method === 'POST') {
        assert.equal(snapshotWrites, 1, 'leaderboard marker must be written after participant snapshots');
        snapshotsReady = true;
        timeline.push('leaderboard-snapshot');
        return respond([]);
      }
      return respond(snapshotsReady ? [{ snapshot_version: 3 }] : []);
    }
    if (target.includes('/rest/v1/participant_score_snapshots?')) {
      if (failFirstScoreWrite) {
        failFirstScoreWrite = false;
        return new Response(JSON.stringify({ message: 'temporary write failure' }), { status: 503 });
      }
      snapshotWrites += 1;
      timeline.push('participant-snapshot');
      return respond([]);
    }
    if (target.includes('/rest/v1/participants?')) return respond([{
      id: 'player-1', alias: 'Ada', registered_at: '2026-09-25T00:00:00Z',
      is_spectator: false, is_rehearsal: false
    }]);
    if (target.includes('/rest/v1/gateway_answers?')) return respond([{
      participant_id: 'player-1', question_id: 'test-question', option_index: 0, response_ms: 400
    }]);
    if (target.includes('/rest/v1/participant_answers?')) return respond([]);
    if (target.includes('/rest/v1/admin_audit_logs')) return respond([]);
    throw new Error(`Unexpected test request: ${target}`);
  };

  try {
    const deadline = await handler({
      httpMethod: 'POST', path: '/api/internal/deadline',
      headers: { authorization: 'Bearer gateway-secret' },
      body: JSON.stringify({ sessionId: session.id, questionId: session.current_question_id, version: 1 })
    });
    assert.equal(deadline.statusCode, 200, deadline.body);
    assert.equal(session.state, 'revealed');
    assert.deepEqual(timeline, ['locked', 'drain', 'persist', 'broadcast']);
    assert.equal(snapshotWrites, 0, 'reveal must not start the expensive scoring reads or writes');

    const adminToken = createAdminSession();
    const blocked = await handler({
      httpMethod: 'POST', path: '/api/admin/action', headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ state: 'leaderboard' })
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(JSON.parse(blocked.body).code, 'SCORING_PENDING');
    assert.equal(session.state, 'revealed');

    const scoreRequest = () => handler({
      httpMethod: 'POST', path: '/api/internal/score',
      headers: { authorization: 'Bearer gateway-secret' },
      body: JSON.stringify({ sessionId: session.id, questionId: session.current_question_id, version: 3 })
    });
    const failedScore = await scoreRequest();
    assert.equal(failedScore.statusCode, 503);
    assert.equal(snapshotsReady, false, 'failed participant writes must not publish the leaderboard marker');

    const score = await scoreRequest();
    assert.equal(score.statusCode, 200, score.body);
    assert.deepEqual(timeline.slice(-2), ['participant-snapshot', 'leaderboard-snapshot']);

    const duplicate = await scoreRequest();
    assert.equal(JSON.parse(duplicate.body).idempotent, true);
    assert.equal(snapshotWrites, 1);

    const shown = await handler({
      httpMethod: 'POST', path: '/api/admin/action', headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ state: 'leaderboard' })
    });
    assert.equal(shown.statusCode, 200, shown.body);
    assert.equal(session.state, 'leaderboard');
  } finally {
    global.fetch = originalFetch;
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
