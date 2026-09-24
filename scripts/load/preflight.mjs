// Read-only gate. Never opens a question, registers users or redirects to production.
import { pathToFileURL } from 'node:url';

export async function preflight(env=process.env, request=fetch) {
  const base=new URL(env.NIAC_BASE_URL || 'https://niaclive-git-feature-admin-pin-auth-zamijudes-projects.vercel.app');
  const gateway=new URL(env.NIAC_GATEWAY_URL || 'https://92.4.146.91.sslip.io');
  if(base.protocol!=='https:' || gateway.protocol!=='https:')throw new Error('HTTPS targets required');
  if(base.hostname==='niaclive.vercel.app')throw new Error('Production is not an authorized load target');
  const blockers=[];
  const automatedBlockers=[];
  const checks=[];
  const blockAutomated=message=>{blockers.push(message);automatedBlockers.push(message);};
  async function get(origin,path,protectedPreview=false) {
    const headers={Accept:'application/json',Origin:base.origin};
    if(protectedPreview && env.VERCEL_AUTOMATION_BYPASS_SECRET)headers['x-vercel-protection-bypass']=env.VERCEL_AUTOMATION_BYPASS_SECRET;
    try {
      const r=await request(new URL(path,origin),{headers,redirect:'manual',signal:AbortSignal.timeout(10000)});
      const json=(r.headers.get('content-type') || '').includes('application/json');
      checks.push({path,origin:origin.origin,status:r.status,json});
      if(origin.origin===gateway.origin && r.headers.get('access-control-allow-origin')!==base.origin)blockAutomated(`${path}: gateway CORS does not allow Preview origin`);
      if(!r.ok || !json){blockAutomated(`${path}: HTTP ${r.status}${json?'':' non-JSON/protection response'}`);return null;}
      return await r.json();
    } catch {blockAutomated(`${path}: network/TLS/timeout failure`);return null;}
  }
  const bootstrap=await get(base,'/api/bootstrap',true);
  const health=await get(gateway,'/gateway/health');
  const state=await get(gateway,'/gateway/state');
  if(bootstrap) {
    if(bootstrap.transport?.gatewayAnswer!==`${gateway.origin}/gateway/answers`)blockAutomated('Preview does not advertise the expected answer gateway');
    if(bootstrap.transport?.gatewaySse!==`${gateway.origin}/gateway/stream`)blockAutomated('Preview does not advertise the expected SSE gateway');
  } else {
    blockAutomated('Preview bootstrap could not be verified');
  }
  if(health) {
    if(!health.durableSinkConfigured)blockAutomated('Gateway durable sink is not configured');
    if(health.queueDepth!==0)blockAutomated('Gateway queue is not empty');
    if(health.connectedClients!==0)blockAutomated(`Gateway must have zero connected clients before load (found ${health.connectedClients ?? 'unknown'})`);
    if(!health.currentState || ['open','locked'].includes(health.currentState))blockAutomated('Gateway is in an active or unknown question state');
    if(state && state.state!==health.currentState)blockAutomated('Gateway health and state endpoints disagree');
  } else {
    blockAutomated('Gateway health could not be verified');
  }
  if(!state) {
    blockAutomated('Gateway state could not be verified');
  }
  // These require operator/host evidence, not a successful public health request.
  blockers.push('Verify deployed gateway commit includes the durability fixes');
  blockers.push('Verify gateway authority origin, rehearsal isolation, host monitoring and exclusive window');
  return {readOnly:true,base:base.origin,gateway:gateway.origin,checks,
    gatewayState:state?{state:state.state,version:state.version}:null,
    gatewayHealth:health?{queueDepth:health.queueDepth,connectedClients:health.connectedClients,durableSinkConfigured:health.durableSinkConfigured}:null,
    blockers,automatedBlockers,automatedReady:automatedBlockers.length===0,readyForLoad:false};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {console.log(JSON.stringify(await preflight(),null,2));process.exitCode=2;}
  catch(error){console.error(error.message);process.exitCode=2;}
}
