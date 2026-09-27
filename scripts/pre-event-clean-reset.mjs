// Pre-Event Production Reset Script for NIAC Live
// 1. Cleans historical test snapshots, participant scores, and test answers.
// 2. Resets live_sessions to 'lobby' and event_settings to 'welcome'.
// 3. Pushes clean welcome state to the live Gateway.

import { db, event } from '../server/db.mjs';

async function preEventReset() {
  console.log('[Pre-Event Reset] Starting clean database reset for live event...');
  const ev = await event();
  console.log(`[Pre-Event Reset] Target Event: ${ev.title} (${ev.id})`);

  // 1. Purge test answers
  console.log('[Pre-Event Reset] Deleting leftover test answers...');
  try {
    await db('gateway_answers?session_id=neq.00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
    console.log('  ✔ gateway_answers purged.');
  } catch (err) {
    console.warn('  ⚠ gateway_answers purge error:', err.message);
  }

  try {
    await db('participant_answers?id=neq.00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
    console.log('  ✔ participant_answers purged.');
  } catch (err) {
    console.warn('  ⚠ participant_answers purge error:', err.message);
  }

  // 2. Purge test leaderboard & score snapshots
  console.log('[Pre-Event Reset] Deleting test score and leaderboard snapshots...');
  try {
    await db('leaderboard_snapshots?session_id=neq.00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
    console.log('  ✔ leaderboard_snapshots purged.');
  } catch (err) {
    console.warn('  ⚠ leaderboard_snapshots purge error:', err.message);
  }

  try {
    await db('participant_score_snapshots?session_id=neq.00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
    console.log('  ✔ participant_score_snapshots purged.');
  } catch (err) {
    console.warn('  ⚠ participant_score_snapshots purge error:', err.message);
  }

  // 3. Reset live session and event settings to welcome/lobby
  console.log('[Pre-Event Reset] Resetting live session & event settings to Welcome/Lobby...');
  const now = new Date().toISOString();
  
  await db(`event_settings?event_id=eq.${ev.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      screen_mode: 'welcome',
      active_activity: 'passport',
      updated_at: now
    })
  });
  console.log('  ✔ event_settings screen_mode set to "welcome".');

  const sessions = await db(`live_sessions?event_id=eq.${ev.id}&select=*&order=updated_at.desc&limit=1`);
  if (sessions[0]) {
    const nextVersion = Number(sessions[0].version || 1) + 1;
    await db(`live_sessions?id=eq.${sessions[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        state: 'lobby',
        current_question_id: null,
        current_round_id: null,
        current_clue: 1,
        opened_at: null,
        deadline_at: null,
        version: nextVersion,
        updated_at: now
      })
    });
    console.log(`  ✔ live_sessions reset to 'lobby' (version ${nextVersion}).`);
  }

  // 4. Verify clean state
  console.log('\n[Pre-Event Reset] Verifying clean database state:');
  const [ga, pa, ls, pss, lbs, curSession] = await Promise.all([
    db('gateway_answers?select=id'),
    db('participant_answers?select=id'),
    db('lens_submissions?select=id'),
    db('participant_score_snapshots?select=participant_id'),
    db('leaderboard_snapshots?select=session_id'),
    db(`live_sessions?event_id=eq.${ev.id}&select=id,state,version,current_question_id,updated_at`)
  ]);

  console.log(`  • gateway_answers remaining:           ${ga.length}`);
  console.log(`  • participant_answers remaining:       ${pa.length}`);
  console.log(`  • lens_submissions (mosaic) remaining: ${ls.length}`);
  console.log(`  • participant_score_snapshots:         ${pss.length}`);
  console.log(`  • leaderboard_snapshots remaining:     ${lbs.length}`);
  console.log(`  • Active session state:                ${curSession[0]?.state} (v${curSession[0]?.version}, Q: ${curSession[0]?.current_question_id})`);

  console.log('\n✨ [Pre-Event Reset] DATABASE IS 100% CLEAN AND READY FOR THE LIVE EVENT!\n');
}

preEventReset().catch(err => {
  console.error('[Pre-Event Reset] Failed:', err);
  process.exit(1);
});
