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

test('mosaic unique word cap retains top anchors and caps at 160 unique words', async () => {
  const stemmerSource = await readFile(new URL('../js/stemmer.js', import.meta.url), 'utf8');
  const context = { exports: {}, module: { exports: {} } };
  runInNewContext(stemmerSource, context);
  const stemmer = context.module.exports;

  const baseTime = Date.now();
  const responses = [];

  // Anchor word with 10 submissions
  for (let i = 0; i < 10; i++) {
    responses.push({ id: `w0-${i}`, raw_word: 'Anchor Vision', created_at: new Date(baseTime - 100000 + i * 1000).toISOString() });
  }

  // 199 single-vote unique words
  for (let i = 1; i <= 199; i++) {
    responses.push({ id: `w${i}`, raw_word: `Unique Word ${i}`, created_at: new Date(baseTime + i * 1000).toISOString() });
  }

  const allGroups = stemmer.aggregateWordGroups(responses);
  assert.equal(allGroups.length, 200);

  let wordGroups = allGroups;
  if (allGroups.length > 160) {
    const topAnchors = allGroups.filter(g => g.count > 1).slice(0, 30);
    const anchorStems = new Set(topAnchors.map(g => g.stem));
    const remainingSlots = 160 - topAnchors.length;
    const recentUnique = allGroups
      .filter(g => !anchorStems.has(g.stem))
      .sort((a, b) => b.latestAt - a.latestAt)
      .slice(0, remainingSlots);
    wordGroups = topAnchors.concat(recentUnique).sort((a, b) => b.count - a.count || b.latestAt - a.latestAt);
  }

  assert.equal(wordGroups.length, 160);
  assert.ok(wordGroups.some(g => g.text.toLowerCase().includes('anchor vision')));
  assert.ok(!wordGroups.some(g => g.text === 'Unique Word 1'));
  assert.ok(wordGroups.some(g => g.text === 'Unique Word 199'));
});
