import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Netlify denies answer-bearing drafts and internal deployment artifacts', () => {
  const config=readFileSync(new URL('../netlify.toml',import.meta.url),'utf8');
  const redirects=config.split('[[redirects]]').slice(1);
  for(const path of ['/review/*','/exports/*','/docs/*','/gateway/*','/.git/*']) {
    const rule=redirects.find(block=>block.includes(`from = "${path}"`));
    assert.ok(rule,`Missing deny rule: ${path}`);
    assert.match(rule,/status = 404/);
    assert.match(rule,/force = true/);
  }
});
