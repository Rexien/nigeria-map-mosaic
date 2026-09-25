import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../server/api.mjs';

test('personal score reads the latest completed snapshot without depending on the current screen version', async () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://db.example';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  const paths = [];
  global.fetch = async url => {
    const path = String(url);
    paths.push(path);
    if (path.includes('/participants?')) {
      assert.match(path, /token_hash=eq\./);
      return new Response(JSON.stringify([{ id: 'player-1', alias: 'Player', registered_at: '2026-09-01T00:00:00Z', is_spectator: false }]), { status: 200 });
    }
    if (path.includes('/participant_score_snapshots?')) {
      assert.match(path, /participant_id=eq\.player-1/);
      assert.match(path, /order=snapshot_version\.desc&limit=1/);
      assert.doesNotMatch(path, /snapshot_version=eq\./);
      return new Response(JSON.stringify([{ rank: 3, snapshot_version: 8, scores: { day1: 800, day2: 0, combined: 800, decode: 0 }, stamps: ['first'] }]), { status: 200 });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    const response = await handler({ httpMethod: 'GET', path: '/api/me', headers: { authorization: 'Bearer player-token' } });
    assert.equal(response.statusCode, 200);
    assert.equal(paths.length, 2);
    const body = JSON.parse(response.body);
    assert.equal(body.scores.combined, 800);
    assert.equal(body.rank, 3);
    assert.equal(body.snapshotVersion, 8);
    assert.deepEqual(body.stamps, ['first']);
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }
});

test('leaderboard reads latest completed snapshot rather than current screen version', async () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://db.example';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  const paths = [];
  global.fetch = async url => {
    const path = String(url);
    paths.push(path);
    if (path.includes('/events?')) return new Response(JSON.stringify([{ id: 'event-1' }]), { status: 200 });
    if (path.includes('/live_sessions?')) return new Response(JSON.stringify([{ id: 'session-1', version: 9, state: 'leaderboard' }]), { status: 200 });
    if (path.includes('/leaderboard_snapshots?')) {
      assert.match(path, /order=snapshot_version\.desc&limit=1/);
      assert.doesNotMatch(path, /snapshot_version=eq\.9/);
      return new Response(JSON.stringify([{ leaders: [{ alias: 'Player', score: 800 }] }]), { status: 200 });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    const response = await handler({ httpMethod: 'GET', path: '/api/leaderboard', queryStringParameters: { activity: 'passport' } });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).leaders[0].alias, 'Player');
    assert.ok(paths.some(path => path.includes('/leaderboard_snapshots?')));
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }
});
