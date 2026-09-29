import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/supabase-client.js', import.meta.url), 'utf8');

test('mosaic keeps the last approved snapshot during a transient read failure', async () => {
  const window = { WordStemmer: { stem: value => value.toLowerCase() } };
  let fail = false;
  runInNewContext(source, {
    window,
    fetch: async () => {
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => ({ responses: [{ id: 'one', phrase: 'Unity', normalized_phrase: 'unity' }] }) };
    },
    setInterval: () => 1,
    clearInterval: () => {}
  });
  assert.equal((await window.MosaicDB.fetchResponses()).length, 1);
  fail = true;
  assert.equal((await window.MosaicDB.fetchResponses())[0].raw_word, 'Unity');
});

test('the first poll after subscribing detects a newly approved word', async () => {
  const window = { WordStemmer: { stem: value => value.toLowerCase() } };
  let responses = [];
  let poll;
  runInNewContext(source, {
    window,
    fetch: async () => ({ ok: true, json: async () => ({ responses }) }),
    setInterval: callback => { poll = callback; return 1; },
    clearInterval: () => {}
  });
  await window.MosaicDB.fetchResponses();
  let updates = 0;
  window.MosaicDB.subscribeRealtime({ onUpdate: () => updates++ });
  responses = [{ id: 'new', phrase: 'Hope', normalized_phrase: 'hope' }];
  await poll();
  assert.equal(updates, 1);
});
