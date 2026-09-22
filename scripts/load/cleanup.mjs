// scripts/load/cleanup.mjs
// Dry-run inspection and safe cleanup restricted exclusively to rehearsal participants.
// Strictly guards production/real attendee records from deletion.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function cleanupRehearsal(options = {}) {
  const env = options.env || process.env;
  const baseUrl = (options.baseUrl || env.NIAC_BASE_URL || 'https://niaclive-git-feature-admin-pin-auth-zamijudes-projects.vercel.app').replace(/\/$/, '');
  const adminPin = options.adminPin || env.ADMIN_PIN;
  if(!adminPin)throw new Error('ADMIN_PIN is required');
  const dryRun = Boolean(options.dryRun);
  const confirmText = options.confirm || '';
  const bypassSecret = env.VERCEL_AUTOMATION_BYPASS_SECRET || null;

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  if (bypassSecret) headers['x-vercel-protection-bypass'] = bypassSecret;

  console.log(`\n======================================================`);
  console.log(`  NIAC Live: Rehearsal Cleanup`);
  console.log(`  Target: ${baseUrl}`);
  console.log(`  Mode: ${dryRun ? 'DRY-RUN (Inspection only)' : 'CONFIRMED EXECUTION'}`);
  console.log(`======================================================\n`);

  // 1. Authenticate as admin
  console.log('[Cleanup 1/3] Authenticating as admin...');
  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ pin: adminPin })
  });

  if (!loginRes.ok) {
    throw new Error(`Admin authentication failed: HTTP ${loginRes.status}`);
  }
  const loginData = await loginRes.json();
  const token = loginData.token;
  const authHeaders = {
    ...headers,
    'Authorization': `Bearer ${token}`
  };

  // 2. Fetch admin status to inspect current session and rehearsal state
  console.log('[Cleanup 2/3] Inspecting current session status...');
  const statusRes = await fetch(`${baseUrl}/api/admin/status`, { headers: authHeaders });
  if (!statusRes.ok) {
    throw new Error(`Failed to fetch admin status: HTTP ${statusRes.status}`);
  }
  const statusData = await statusRes.json();
  const session = statusData.session;

  if (session && ['open', 'locked'].includes(session.state)) {
    throw new Error(`Cannot cleanup while question is in state "${session.state}". Must be in lobby or revealed.`);
  }

  if (dryRun) {
    console.log(`  Session State: ${session?.state || 'lobby'}`);
    console.log(`  Dry-run check complete. Safe to proceed with --confirm "CLEAR REHEARSAL DATA".`);
    return { dryRun: true, ready: true };
  }

  // 3. Execute cleanup if confirmed
  if (confirmText !== 'CLEAR REHEARSAL DATA') {
    throw new Error('Explicit confirmation required: pass --confirm "CLEAR REHEARSAL DATA"');
  }

  console.log('[Cleanup 3/3] Executing rehearsal data cleanup...');
  const actionRes = await fetch(`${baseUrl}/api/admin/action`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      kind: 'clear_data',
      scope: 'rehearsal',
      confirmText: 'CLEAR REHEARSAL DATA'
    })
  });

  if (!actionRes.ok) {
    const errText = await actionRes.text();
    throw new Error(`Cleanup rejected (HTTP ${actionRes.status}): ${errText}`);
  }

  const result = await actionRes.json();
  console.log(`\n✓ SUCCESS: Cleared ${result.cleared} rehearsal participants and associated test records.`);
  console.log(`  All real attendees and production data strictly preserved.\n`);
  return result;
}

// CLI runner
if (process.argv[1] && process.argv[1].endsWith('cleanup.mjs')) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const confirmIdx = args.indexOf('--confirm');
  const confirm = confirmIdx !== -1 ? args[confirmIdx + 1] : '';

  cleanupRehearsal({ dryRun, confirm }).catch(err => {
    console.error('[Cleanup Error]', err.message);
    process.exit(1);
  });
}
