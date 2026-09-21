// Read-only integration gate: production handlers against an in-memory DB fixture.
// Never connects to Supabase or deletes hosted data.
import assert from 'node:assert/strict';
import { handler } from '../server/api.mjs';
import { createAdminSession } from '../server/admin-auth.mjs';
import { verifyParticipantCredential } from '../lib/credentials.mjs';
import { generateSnapshots } from '../lib/snapshot-scoring.mjs';

process.env.SUPABASE_URL = 'https://fixture.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-only';
process.env.ADMIN_SESSION_SECRET = 'fixture-admin-secret-at-least-32-characters';
delete process.env.PUBLIC_GATEWAY_URL;
const participants = [{ id: 'real', alias: 'Real attendee', is_rehearsal: false }];
const requests = [];
const originalFetch = global.fetch;
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
global.fetch = async (input, options = {}) => {
  const url = new URL(input);
  assert.equal(url.hostname, 'fixture.invalid', 'External requests forbidden');
  const table = url.pathname.replace('/rest/v1/', '');
  const method = options.method || 'GET';
  requests.push({ table, method, query: url.search });
  if (table === 'events') return response([{ id: 'event-fixture' }]);
  if (table === 'event_settings') return response([{ rehearsal_mode: true }]);
  if (table === 'live_sessions') return response([{ id: 'session-fixture', state: 'lobby', version: 1 }]);
  if (table === 'participants' && method === 'POST') {
    const row = { id: 'test-player', is_rehearsal: false, ...JSON.parse(options.body) };
    participants.push(row);
    return response([row]);
  }
  if (table === 'participants' && method === 'DELETE') {
    assert.equal(url.searchParams.get('is_rehearsal'), 'eq.true');
    assert.equal(url.searchParams.get('event_id'), 'eq.event-fixture');
    // Existing migration has NO CASCADE on participant_answers/lens_submissions.
    // Model a rehearsal player that has actually played and submitted a Lens.
    const dependentDeletes = requests.filter(r => r.method === 'DELETE').map(r => r.table);
    if (!dependentDeletes.includes('participant_answers') || !dependentDeletes.includes('lens_submissions')) {
      return response({ message: 'participant foreign key still referenced by answers/lens' }, 409);
    }
    participants.splice(1);
    return response([]);
  }
  if (table === 'participants') return response(participants.filter(p => p.is_rehearsal));
  if (table === 'admin_audit_logs') return response([]);
  return response([]);
};
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); }
  catch (error) { failures++; console.log(`FAIL: ${name}: ${error.message}`); }
}
try {
  await check('rehearsal join marks database row and signed gateway credential', async () => {
    const result = await handler({ path: '/api/participants', httpMethod: 'POST', headers: {}, body: JSON.stringify({ alias: 'Test attendee', rehearsal: true }) });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(participants[1].is_rehearsal, true, 'is_rehearsal must be true');
    assert.equal(verifyParticipantCredential(body.credential).payload.isRehearsal, true);
  });
  await check('rehearsal winner cannot displace real attendee in either leaderboard', () => {
    const snapshots = generateSnapshots({ sessionId: 'session-fixture', snapshotVersion: 1,
      participants: [participants[0], { id: 'test-player', alias: 'Test attendee', is_rehearsal: true }],
      questions: [{ id: 'q', correctOption: 0, activity: 'passport' }],
      answers: [{ participant_id: 'test-player', question_id: 'q', option_index: 0, response_ms: 100 }] });
    for (const board of Object.values(snapshots.leaderboards)) {
      assert.ok(!board.leaders.some(p => p.alias === 'Test attendee'), 'rehearsal player appeared in leaderboard');
    }
  });
  await check('clear rehearsal removes played test records while retaining real attendee', async () => {
    participants[1].is_rehearsal = true; // Seed known test data independently of broken join.
    const result = await handler({ path: '/api/admin/action', httpMethod: 'POST',
      headers: { authorization: `Bearer ${createAdminSession()}` },
      body: JSON.stringify({ kind: 'clear_data', scope: 'rehearsal', confirmText: 'CLEAR REHEARSAL DATA' }) });
    assert.equal(result.statusCode, 200, 'clear must handle existing answer/Lens foreign keys');
    assert.deepEqual(participants.map(p => p.id), ['real']);
  });
} finally { global.fetch = originalFetch; }
console.log(`Isolation gate: ${3 - failures}/3 passed; no hosted data touched.`);
process.exitCode = failures ? 1 : 0;
