import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../server/api.mjs';

test('Supabase fetch transport failures log safe nested cause metadata', async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const secret = 'fixture-service-role-secret';
  const logs = [];

  process.env.SUPABASE_URL = 'https://fixture.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = secret;
  globalThis.fetch = async () => {
    const cause = Object.assign(new Error('connect ECONNRESET fixture.supabase.co:443'), {
      code: 'ECONNRESET',
      syscall: 'connect',
      hostname: 'fixture.supabase.co',
      port: 443
    });
    throw new TypeError('fetch failed', { cause });
  };
  console.error = line => logs.push(String(line));

  try {
    const response = await handler({
      httpMethod: 'POST',
      path: '/api/participants',
      headers: { 'x-request-id': 'transport-test-request' },
      body: JSON.stringify({ alias: 'Test player' })
    });

    assert.equal(response.statusCode, 500);
    const log = JSON.parse(logs.find(line => line.includes('"event":"api_error"')));
    assert.equal(log.dependency, 'supabase_rest');
    assert.equal(log.error, 'Supabase REST transport request failed');
    assert.equal(log.errorCause.name, 'TypeError');
    assert.equal(log.errorCause.message, 'fetch failed');
    assert.equal(log.errorCause.cause.code, 'ECONNRESET');
    assert.equal(log.errorCause.cause.syscall, 'connect');
    assert.equal(log.errorCause.cause.hostname, 'fixture.supabase.co');
    assert.equal(log.errorCause.cause.port, 443);
    assert.equal(log.errorCause.cause.message, 'connect ECONNRESET fixture.supabase.co:443');
    assert.doesNotMatch(JSON.stringify(log), new RegExp(secret));
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
});
