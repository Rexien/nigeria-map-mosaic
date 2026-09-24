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

function healthyResponses({connectedClients=0,currentState='leaderboard',queueDepth=0}={}) {
  const preview='https://niaclive-git-codex-load-reliability-zamijudes-projects.vercel.app';
  const gateway='https://92.4.146.91.sslip.io';
  return async url=>{
    const target=new URL(url);
    if(target.origin===preview)return Response.json({transport:{
      gatewayAnswer:`${gateway}/gateway/answers`,gatewaySse:`${gateway}/gateway/stream`
    }});
    if(target.pathname==='/gateway/health')return Response.json({
      durableSinkConfigured:true,queueDepth,connectedClients,currentState
    },{headers:{'access-control-allow-origin':preview}});
    return Response.json({state:currentState,version:7},{headers:{'access-control-allow-origin':preview}});
  };
}

test('load preflight is automated-ready only when the gateway has no listeners, open question, or queued writes',async()=>{
  const env={NIAC_BASE_URL:'https://niaclive-git-codex-load-reliability-zamijudes-projects.vercel.app'};
  const safe=await preflight(env,healthyResponses());
  assert.equal(safe.automatedReady,true);
  assert.deepEqual(safe.automatedBlockers,[]);

  const listeners=await preflight(env,healthyResponses({connectedClients:2}));
  assert.equal(listeners.automatedReady,false);
  assert.ok(listeners.automatedBlockers.some(b=>b.includes('zero connected clients')));

  const active=await preflight(env,healthyResponses({currentState:'open'}));
  assert.equal(active.automatedReady,false);
  assert.ok(active.automatedBlockers.some(b=>b.includes('active or unknown question state')));

  const queued=await preflight(env,healthyResponses({queueDepth:1}));
  assert.equal(queued.automatedReady,false);
  assert.ok(queued.automatedBlockers.some(b=>b.includes('queue is not empty')));
});
