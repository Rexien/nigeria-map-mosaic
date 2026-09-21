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
  process.env.ADMIN_PIN_HASH = HASH;
  process.env.ADMIN_SESSION_SECRET = SECRET;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (beforeHash === undefined) delete process.env.ADMIN_PIN_HASH;
      else process.env.ADMIN_PIN_HASH = beforeHash;
      if (beforeSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
      else process.env.ADMIN_SESSION_SECRET = beforeSecret;
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
