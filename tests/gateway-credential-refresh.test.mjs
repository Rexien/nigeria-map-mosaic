import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/niac-api.js', import.meta.url), 'utf8');
const signed = `${Buffer.from(JSON.stringify({ expiresAt: Date.now() + 3600000 })).toString('base64url')}.signature`;

function makeApi(fetch) {
  const values = new Map([['niac_participant_token', 'old-participant-token']]);
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
  const window = { APP_CONFIG: { API_BASE: '/api' } };
  vm.runInNewContext(source, {
    window, localStorage: storage, sessionStorage: storage, fetch,
    Response, AbortController, setTimeout, clearTimeout,
    atob: value => Buffer.from(value, 'base64').toString('binary')
  });
  return { api: window.NIACApi, storage };
}

test('old participant token obtains a fresh credential before sending to Oracle', async () => {
  const calls = [];
  const { api } = makeApi(async (url, options) => {
    calls.push({ url, authorization: options.headers.authorization });
    if (url === '/api/me/credential') return Response.json({ credential: signed });
    if (url === 'https://gateway.example/gateway/answers') return Response.json({ accepted: true });
    throw new Error(`Unexpected request ${url}`);
  });
  api.configureGateway('https://gateway.example/gateway/answers');
  const answer = await api.request('/answers', { method: 'POST', body: { optionIndex: 1 } });
  assert.equal(answer.accepted, true);
  assert.deepEqual(calls.map(call => call.url), ['/api/me/credential', 'https://gateway.example/gateway/answers']);
  assert.equal(calls[0].authorization, 'Bearer old-participant-token');
  assert.equal(calls[1].authorization, `Bearer ${signed}`);
});

test('credential refresh failure falls back to authenticated Vercel answer API', async () => {
  const calls = [];
  const { api } = makeApi(async (url, options) => {
    calls.push({ url, authorization: options.headers.authorization });
    if (url === '/api/me/credential') throw new Error('Temporary refresh failure');
    if (url === '/api/answers') return Response.json({ recorded: true, accepted: true });
    throw new Error(`Unexpected request ${url}`);
  });
  api.configureGateway('https://gateway.example/gateway/answers');
  const answer = await api.request('/answers', { method: 'POST', body: { optionIndex: 1 } });
  assert.equal(answer.recorded, true);
  assert.deepEqual(calls.map(call => call.url), ['/api/me/credential', '/api/answers']);
  assert.equal(calls[1].authorization, 'Bearer old-participant-token');
});

test('Oracle credential rejection falls back to Vercel rather than losing the answer', async () => {
  const calls = [];
  const { api, storage } = makeApi(async (url, options) => {
    calls.push({ url, authorization: options.headers.authorization });
    if (url === 'https://gateway.example/gateway/answers') return Response.json({ code: 'EXPIRED', error: 'Credential expired' }, { status: 401 });
    if (url === '/api/me/credential') return Response.json({ credential: signed });
    if (url === '/api/answers') return Response.json({ recorded: true, accepted: true });
    throw new Error(`Unexpected request ${url}`);
  });
  storage.setItem('niac_participant_credential', signed);
  api.configureGateway('https://gateway.example/gateway/answers');
  const answer = await api.request('/answers', { method: 'POST', body: { optionIndex: 1 } });
  assert.equal(answer.recorded, true);
  assert.ok(calls.some(call => call.url === '/api/answers'));
  assert.equal(calls.find(call => call.url === '/api/answers').authorization, 'Bearer old-participant-token');
});
