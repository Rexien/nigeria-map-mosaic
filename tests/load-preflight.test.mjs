import test from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from '../scripts/load/preflight.mjs';

test('load preflight refuses production before any request',async()=>{
  await assert.rejects(preflight({NIAC_BASE_URL:'https://niaclive.vercel.app'},()=>{throw new Error('unexpected request');}),/Production/);
});

test('load preflight does not follow protection redirects or send bypass secret to gateway',async()=>{
  const calls=[];
  const report=await preflight({VERCEL_AUTOMATION_BYPASS_SECRET:'fixture-secret'},async(url,options)=>{
    calls.push({url:String(url),options});
    return new Response('',{status:302,headers:{location:'https://vercel.com/login'}});
  });
  assert.equal(calls.length,3);
  assert.equal(calls[0].options.headers['x-vercel-protection-bypass'],'fixture-secret');
  for(const call of calls){assert.equal(call.options.redirect,'manual');assert.equal(call.options.method,undefined);}
  for(const call of calls.slice(1))assert.equal(call.options.headers['x-vercel-protection-bypass'],undefined);
  assert.equal(report.readyForLoad,false);
  assert.ok(report.blockers.some(b=>b.includes('302')));
  assert.ok(!JSON.stringify(report).includes('fixture-secret'));
});
