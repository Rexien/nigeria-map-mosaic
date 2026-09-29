import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupRehearsal } from '../scripts/load/cleanup.mjs';

test('rehearsal cleanup requires an explicit site target before making requests', async () => {
  await assert.rejects(
    cleanupRehearsal({ env: { ADMIN_PIN: 'test-only' }, dryRun: true }),
    /NIAC_BASE_URL is required/
  );
});
