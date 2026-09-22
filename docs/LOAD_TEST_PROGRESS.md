# Load validation progress — 22 September 2026

Branch: `codex/load-reliability`, based on fetched `origin/feature/admin-pin-auth` at `aa011e914bd29931d6b8f8abd4a4d74f4ce66162`. No main changes, merge, push or live service mutation.

## Implemented

- Buffered answer retries now wait for the same SQLite commit outcome; failed commits reject original and duplicate requests.
- Supabase flush requests abort after 4 seconds by default (`SUPABASE_FLUSH_TIMEOUT_MS`). Failed/ambiguous requests leave records queued; retries retain existing conflict-ignore semantics.
- Drain callers have a real deadline even for a non-cooperative sink. A still-active write retains its single-flight lock; timing out does not mark answers flushed or allow concurrent duplicate flushes.
- Four regression tests cover commit ordering, transaction failure, hung drain and timeout/retry recovery.
- Added read-only `scripts/load/preflight.mjs` with production refusal, redirect refusal, CORS checks and secret-safe diagnostics. Two regression tests cover its safety constraints. This is a diagnostic gate, not the complete load harness, and never claims readiness automatically.

## Verification

- Full Node suite before preflight test additions: **130/130 passed**, including four new durability tests.
- Existing real-browser viewport matrix: all assertions passed (phone 360/390 widths; projectors 1024×768, 1280×720, 1366×768, 1920×1080).
- The default Node suite also discovers an existing LOCAL synthetic 1,000-player script. It is not deployed capacity evidence; its duplicate counter was only 51/100 despite printing a pass verdict. Do not cite its headline as event readiness.

## Read-only deployed observations

- Candidate Preview bootstrap inaccessible: HTTP 401 with JSON Accept; separate default request redirects HTTP 302. Automation access must be established, not a silent switch to production.
- Oracle gateway health/state HTTP 200: lobby, version 67, zero listeners, empty queue, durable sink configured. This does not prove successful durable writes under load.
- Actual gateway directory: `/home/ubuntu/niac-gateway`, deployed files without Git metadata. It differs from the repository service template path.
- Its `.env` has `AUTHORITY_BASE_URL=https://niaclive.vercel.app` and `PUBLIC_APP_ORIGIN=https://niaclive.vercel.app`. These are file observations, not a claim that the live process environment was independently extracted.
- Service MemoryMax 192 MiB; MemoryCurrent approximately 97 MiB; LimitNOFILE 65,536; zero restarts at inspection.
- VM: 956 MiB total RAM, 362 MiB available, 98 MiB swap used, disk 18% used. Footy `eplbot` active.

## Remaining blockers and sequence

1. Obtain authorized Preview automation access (`VERCEL_AUTOMATION_BYPASS_SECRET` securely, not in committed files). Gateway-to-Preview callbacks also need access, not just the test runner.
2. Confirm exclusive rehearsal window and whether to temporarily target this shared gateway at Preview or provide an isolated test gateway. A Preview URL does not isolate production infrastructure.
3. Review/deploy these gateway fixes and verify hashes, public origins, authority target and host monitoring. Current local edits have NOT been deployed.
4. Complete and locally validate the manifest/HTTP/SSE/controller/reconciliation harness from `LOAD_TEST_PLAN.md`. These parts are still pending; do not use the old baseline as a substitute.
5. Verify deployed rehearsal isolation and cleanup on a tiny fixture before ramping the approved ladder.

No deployed load test, participant registration, question change, cleanup or service restart was performed. No capacity claim is made.
