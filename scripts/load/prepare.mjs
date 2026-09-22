// scripts/load/prepare.mjs
// Registers rehearsal participants with bounded arrival rate and saves a private credential manifest.
// Strictly marks is_rehearsal: true and preserves existing real attendees.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function rehearsalAlias(runId, index) {
  const aliasRun = String(runId).replace(/[^\p{L}\p{N}]/gu, '').slice(-18) || Date.now().toString(36);
  return `Reh${aliasRun}${String(index).padStart(4, '0')}`;
}

export async function prepareParticipants(options = {}) {
  const env = options.env || process.env;
  const baseUrl = (options.baseUrl || env.NIAC_BASE_URL || 'https://niaclive-git-feature-admin-pin-auth-zamijudes-projects.vercel.app').replace(/\/$/, '');
  const gatewayUrl = (options.gatewayUrl || env.NIAC_GATEWAY_URL || 'https://92.4.146.91.sslip.io').replace(/\/$/, '');
  const count = Number(options.participants || 50);
  const joinRate = Number(options.joinRate || 10); // joins per second
  const runId = options.runId || env.NIAC_RUN_ID || `rehearsal-${Date.now()}`;
  const outDir = options.outDir || env.NIAC_RESULTS_DIR || path.join(__dirname, '..', '..', 'artifacts', 'load', runId);
  const bypassSecret = env.VERCEL_AUTOMATION_BYPASS_SECRET || null;

  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'credentials.json');
  if(fs.existsSync(manifestPath))throw new Error('Run manifest already exists; use a fresh run ID');

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  if (bypassSecret) {
    headers['x-vercel-protection-bypass'] = bypassSecret;
  }

  // 1. Fetch bootstrap once to verify gateway alignment
  console.log(`[Prepare] Connecting to ${baseUrl} (run: ${runId})...`);
  const bootRes = await fetch(`${baseUrl}/api/bootstrap`, { headers });
  if (!bootRes.ok) {
    throw new Error(`Bootstrap failed: HTTP ${bootRes.status} from ${baseUrl}/api/bootstrap`);
  }
  const bootstrap = await bootRes.json();
  const eventId = bootstrap.state?.eventId;
  const sessionId = bootstrap.state?.sessionId;
  if(!eventId || !sessionId || bootstrap.transport?.gatewayAnswer!==`${gatewayUrl}/gateway/answers`)throw new Error('Bootstrap identity/gateway mismatch');
  console.log(`[Prepare] Event: ${eventId}, Session: ${sessionId}, Gateway: ${bootstrap.transport?.gatewayAnswer}`);

  // 2. Register participants with rate limiter
  console.log(`[Prepare] Registering ${count} rehearsal participants at ~${joinRate}/sec...`);
  const delayMs = Math.max(10, Math.floor(1000 / joinRate));
  const participants = [];
  const startMs = Date.now();
  for (let i = 1; i <= count; i++) {
    const alias = rehearsalAlias(runId, i);
    const payload = {
      alias,
      eventId,
      is_rehearsal: true,
      rehearsal: true
    };

    const t0 = Date.now();
    let res;
    try {
      res = await fetch(`${baseUrl}/api/participants`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
    } catch (err) {
      throw new Error(`Join request failed for ${alias}: ${err.message}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Participant join rejected (HTTP ${res.status}): ${text}`);
    }

    const data = await res.json();
    const durationMs = Date.now() - t0;

    participants.push({
      index: i,
      id: data.participant.id,
      alias: data.participant.alias,
      token: data.token, // authority opaque token
      credential: data.credential, // signed gateway credential
      isRehearsal: true,
      durationMs
    });
    // Preserve the recovery inventory even if a later join fails.
    fs.writeFileSync(manifestPath,JSON.stringify({runId,baseUrl,gatewayUrl,eventId,sessionId,count:participants.length,participants},null,2),{mode:0o600});

    if (i % 25 === 0 || i === count) {
      console.log(`[Prepare] Registered ${i}/${count} (${Math.round((i / (Date.now() - startMs)) * 1000)}/s)`);
    }

    if (i < count) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify({
    runId,
    timestamp: new Date().toISOString(),
    baseUrl,
    gatewayUrl,
    eventId,
    sessionId,
    count: participants.length,
    participants
  }, null, 2));

  console.log(`[Prepare] Complete! Saved ${participants.length} credentials to ${manifestPath}`);
  return { manifestPath, participants, eventId, sessionId };
}

// CLI runner
if (process.argv[1] && process.argv[1].endsWith('prepare.mjs')) {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };

  const participants = Number(getArg('--participants', 50));
  const joinRate = Number(getArg('--join-rate', 10));
  const runId = getArg('--run-id', `rehearsal-${Date.now()}`);

  prepareParticipants({ participants, joinRate, runId }).catch(err => {
    console.error('[Prepare Error]', err);
    process.exit(1);
  });
}
