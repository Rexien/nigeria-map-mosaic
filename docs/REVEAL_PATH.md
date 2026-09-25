# Reveal and scoring sequence

On the configured Oracle gateway path, an expired question now follows this order:

1. Authority changes `open` to `locked`.
2. Gateway broadcasts the lock and drains its SQLite answer queue to the durable sink. A drain failure stops the reveal.
3. Authority persists `revealed` with the next session version.
4. Authority broadcasts the revealed state. Phones and the projector can show the correct answer now.
5. Gateway starts a separate authenticated `/api/internal/score` request. It retries transient failures and rechecks a revealed state after restart. The scoring endpoint is idempotent for the same session/question/version.
6. Participant score snapshots are written first; the leaderboard snapshot is written last as the completion marker. Admin actions that show the leaderboard or move to another activity/question are rejected with `SCORING_PENDING` until the marker exists. Participant screens say “Scores are updating…” during reveal, then fetch the completed score when the leaderboard is shown.

Production deployment requires **both** the Vercel authority and Oracle gateway changes. Deploy/restart the gateway first, then deploy the authority; do not open a live round during the rollout. The new gateway may temporarily receive a 404 from the old authority scoring route and retry, while the old authority continues scoring in its original reveal path. Reversing the order risks a revealed question with no scorer. With no configured/reachable gateway, scoring falls back to the authority request after reveal persistence. That mode remains correct but does not have the fast broadcast guarantee.

Structured `reveal_path_timing` logs contain the session/question/version and absolute deadline-to-`locked`, `drain_complete`, `revealed_persisted`, `reveal_broadcast`, and `scoring_complete` timings. `snapshot_scoring_complete` separates read/compute from persistence and records participant/answer counts. These measurements must be checked on a realistic 1,000-player rehearsal; the ~1-second visible reveal target is not proven by unit or browser tests. Queue drain and network/database writes remain on the critical path.

Scoring still rereads all answers and participants for the session and writes a score row for each participant every question. This is deliberately unchanged in this fix: skipping historical participants without a maintained per-participant aggregate could produce stale scores or ranks (especially after voiding). Incremental scoring should be a separately tested change. Clearing old rehearsal participants before the event reduces snapshot work in the meantime.
