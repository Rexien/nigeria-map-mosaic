# NIAC Live finish line

Status date: 22 September 2026. Owner: Codex. Working branch: `codex/load-reliability`. Production branch `main` remains untouched until review and explicit promotion.

## Phase 1 — Correctness lock

Exit criteria:

- acknowledgments follow the SQLite commit and remote flush/drain has a deadline;
- authority fallback matches the installed database contract;
- retries preserve session, question, option and idempotency identity;
- accepted answers reconcile field-for-field with durable rows;
- tooling cannot turn timeouts, HTTP 409s or forced reveals into false passes;
- deterministic tests pass.

Current state: reliability and fallback contract fixes exist locally; harness hardening is in progress. Cross-route fallback still needs a tiny deployed fault smoke. No capacity claim yet.

## Phase 2 — Controlled deployment and smoke

Deploy reviewed gateway files to Oracle and authority changes to protected Vercel Preview. Record local commit, Vercel deployment and remote hashes. Never copy secrets into scripts or evidence.

Run 2–5 rehearsal identities through healthy answers, duplicate retries, a failed gateway request followed by fallback, automatic drain/reveal, `/me`, durable comparison and cleanup inventory.

Exit: exact durable payloads, one row/award per player/question, automatic reveal, queue zero, no rehearsal ranking leakage and no real-participant deletion.

## Phase 3 — Trusted baseline

Calibrate the laptop, then repeat 50 and 100 participants with fresh identities/questions. Separate generator scheduling delay, connection failures and server latency. Do not enable fallback during the healthy-path baseline.

Exit: three passing rounds per tier, durable answers, exact duplicates, SSE and `/me` gates, no dropped or late-scheduled operations, and clean host/provider telemetry. Diagnose rather than relabel any eight-second timeout.

## Phase 4 — Capacity ladder

Run 250 → 500 → 750 → 1,000, reconciling after every tier. At 1,000 test five-second then two-second bursts; run the one-second boundary only after those pass. 1,250/1,500 are optional headroom evidence.

Stop immediately on lost/changed answers, wrong scores, rehearsal leakage, premature reveal, persistent queue, restart/OOM, host limits or generator invalidation.

## Phase 5 — Resilience rehearsal

At the proven tier test SSE reconnects, a limited fallback cohort, repeated rounds with fresh identities, Lens traffic, admin actions and a 30-minute mixed soak. Venue Wi-Fi gets a separate real-device check.

Exit: recovery without stale state, duplicate scoring or loss; stable resource trends; documented normal and fallback operating limits.

## Phase 6 — Release and event readiness

Review and commit cohesive changes; publish the capacity verdict and remaining risks; finish the event-day runbook, monitors, abort/rollback steps and environment checks; inventory and explicitly approve cleanup; review against `feature/admin-pin-auth`; promote only through the agreed process.

Done means the exact deployed revision passed realistic traffic with zero correctness failures and the team can operate and recover it. A localhost benchmark or green health endpoint alone is not done.
