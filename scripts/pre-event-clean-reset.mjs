// Pre-Event Production Reset Script for NIAC Live
// 1. Cleans all participants, recovery codes, stamps, and score totals.
// 2. Cleans all lens mosaic submissions and test responses.
// 3. Cleans historical test snapshots, participant scores, and test answers.
// 4. Resets live_sessions to 'lobby' and event_settings to 'welcome'.

import { db, event } from '../server/db.mjs';

async function preEventReset() {
  console.log('[Pre-Event Reset] Starting complete database purge to zero for live event...');
  const ev = await event();
  console.log(`[Pre-Event Reset] Target Event: ${ev.title} (${ev.id})`);

  // 1. Purge test answers and gateway submissions
  console.log('[Pre-Event Reset] Deleting test answers & gateway answers...');
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

  // 2. Purge lens submissions & legacy responses
  console.log('[Pre-Event Reset] Deleting mosaic lens submissions & responses...');
  try {
    await db(`lens_submissions?event_id=eq.${ev.id}`, { method: 'DELETE' });
    console.log('  ✔ lens_submissions purged.');
  } catch (err) {
    console.warn('  ⚠ lens_submissions purge error:', err.message);
  }

  try {
    await db('responses?id=neq.00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
    console.log('  ✔ legacy responses purged.');
  } catch (err) {
    // Might not exist or be empty
  }

  // 3. Purge test leaderboard & score snapshots
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

  // 4. Purge score totals and passport stamps
  console.log('[Pre-Event Reset] Deleting score totals and passport stamps...');
  try {
    await db('score_totals?participant_id=neq.00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
    console.log('  ✔ score_totals purged.');
  } catch (err) {
    console.warn('  ⚠ score_totals purge error:', err.message);
  }

  try {
    await db('passport_stamps?participant_id=neq.00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
    console.log('  ✔ passport_stamps purged.');
  } catch (err) {
    console.warn('  ⚠ passport_stamps purge error:', err.message);
  }

  // 5. Purge participant recovery codes & participants
  console.log('[Pre-Event Reset] Deleting participants and recovery codes...');
  try {
    await db('participant_recovery_codes?participant_id=neq.00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
    console.log('  ✔ participant_recovery_codes purged.');
  } catch (err) {
    console.warn('  ⚠ participant_recovery_codes purge error:', err.message);
  }

  try {
    await db(`participants?event_id=eq.${ev.id}`, { method: 'DELETE' });
    console.log('  ✔ participants purged.');
  } catch (err) {
    console.warn('  ⚠ participants purge error:', err.message);
  }

  // 6. Reset live question state
  try {
    await db('live_question_state?session_id=neq.00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
    console.log('  ✔ live_question_state purged.');
  } catch (err) {
    console.warn('  ⚠ live_question_state purge error:', err.message);
  }

  // 7. Reset live session and event settings to welcome/lobby
  console.log('[Pre-Event Reset] Resetting live session & event settings to Welcome/Lobby...');
  const now = new Date().toISOString();
  
  await db(`event_settings?event_id=eq.${ev.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      screen_mode: 'welcome',
      active_activity: 'passport',
      rehearsal_mode: false,
      updated_at: now
    })
  });
  console.log('  ✔ event_settings screen_mode set to "welcome", rehearsal_mode=false.');

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

  // 8. Verify clean state
  console.log('\n[Pre-Event Reset] Verifying clean database state:');
  const [parts, ga, pa, ls, pss, lbs, st, ps, curSession, curSettings] = await Promise.all([
    db(`participants?event_id=eq.${ev.id}&select=id`),
    db('gateway_answers?select=id'),
    db('participant_answers?select=id'),
    db(`lens_submissions?event_id=eq.${ev.id}&select=id`),
    db('participant_score_snapshots?select=participant_id'),
    db('leaderboard_snapshots?select=session_id'),
    db('score_totals?select=participant_id'),
    db('passport_stamps?select=participant_id'),
    db(`live_sessions?event_id=eq.${ev.id}&select=id,state,version,current_question_id,updated_at`),
    db(`event_settings?event_id=eq.${ev.id}&select=*`)
  ]);

  console.log(`  • participants remaining:              ${parts.length}`);
  console.log(`  • gateway_answers remaining:           ${ga.length}`);
  console.log(`  • participant_answers remaining:       ${pa.length}`);
  console.log(`  • lens_submissions (mosaic) remaining: ${ls.length}`);
  console.log(`  • score_totals remaining:              ${st.length}`);
  console.log(`  • passport_stamps remaining:           ${ps.length}`);
  console.log(`  • participant_score_snapshots:         ${pss.length}`);
  console.log(`  • leaderboard_snapshots remaining:     ${lbs.length}`);
  console.log(`  • Active session state:                ${curSession[0]?.state} (v${curSession[0]?.version}, Q: ${curSession[0]?.current_question_id})`);
  console.log(`  • Event settings:                      mode=${curSettings[0]?.screen_mode}, activity=${curSettings[0]?.active_activity}, rehearsal=${curSettings[0]?.rehearsal_mode}`);

  const allZero = parts.length === 0 && ga.length === 0 && pa.length === 0 && ls.length === 0 &&
                  st.length === 0 && ps.length === 0 && pss.length === 0 && lbs.length === 0;

  if (allZero) {
    console.log('\n✨ [Pre-Event Reset] SUCCESS: ALL PARTICIPANTS AND DATA CLEARED TO EXACTLY ZERO!\n');
  } else {
    console.warn('\n⚠ [Pre-Event Reset] Some rows remain non-zero. Check above counts.');
  }
}

preEventReset().catch(err => {
  console.error('[Pre-Event Reset] Failed:', err);
  process.exit(1);
});
