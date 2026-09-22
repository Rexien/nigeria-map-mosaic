# NIAC Live deployed performance and correctness validation

Prepared 22 September 2026. **Plan only: no deployed load run is authorized by this document.** Implement the proposed harness after approval. Never treat a successful command exit or a localhost benchmark as event capacity certification.

## 1. Evidence and architecture

Inspected checkout: `feature/admin-pin-auth`, `aa011e914bd29931d6b8f8abd4a4d74f4ce66162`, clean at inspection. Recent changes include `6c85fcb` rehearsal isolation and `31a07ed` HTTP-200 join handling. Pin the tested commit and record Vercel deployment ID and gateway commit before execution; this inspection does not establish which commit either host runs.

Read the handoff, deployment/ADR/capacity runbooks and VM rehearsal report. Their Netlify deployment descriptions and two-second authority polling statements are historical. Current code is decisive:

| Path | Current implementation and test implication |
| --- | --- |
| Frontend and authority | `vercel.json` rewrites `/api/*` to `api/index.js` → `server/api.mjs`. Static frontend copied by `scripts/build-static.mjs`. |
| Join | Vercel `/api/participants` writes participant through Supabase REST; returns HTTP 200, opaque authority token and separately signed gateway credential. |
| Bootstrap/state | `/api/bootstrap` advertises gateway SSE and answer URLs. `js/niac-transport.js` uses SSE, local countdowns, and jittered fallback polling. |
| SSE | Browser → Caddy HTTPS → Node `/gateway/stream`. Initial state plus versioned events; 15-second keepalive. This is not one network countdown tick per second. |
| Normal answer | `js/niac-api.js` posts signed credential to `/gateway/answers`. Gateway validates cached session/question/deadline and queues answer. |
| Queue | `gateway/lib/sqlite-queue.mjs`: disk SQLite WAL, `synchronous=FULL`, group commit at 25 records or 15 ms. Acknowledgment normally follows local commit, not Supabase persistence. |
| Durable sink | `gateway/lib/batch-flusher.mjs` runs one batch at a time, up to 100 records, then waits 150 ms between scheduled flushes. Gateway sends HTTP REST upserts to Supabase `gateway_answers`, ignoring participant/question conflicts. |
| Reveal | Authority locks, invokes gateway lock-and-drain, reads answers, computes scores, writes snapshots, then reveals/pushes. `server/api.mjs`, not the synthetic scoring helper alone, is the deployed integration under test. |
| Fallback | Network/timeout/5xx on gateway answer can fall back to Vercel using the opaque token; gateway 4xx does not trigger fallback. Default answer request timeout is 8 seconds. State polling is normally 3–5 seconds with retries/backoff. |
| Lens | `/api/lens` writes through Vercel. `js/supabase-client.js` polls `/api/lens/approved` every 3 seconds per Lens display. Lens is not using quiz SSE for its mosaic data. |

The main path is **phone → Oracle queue → Supabase**, with **Vercel controlling the session and scoring**. It is not a chain where every answer passes Oracle → Vercel → Supabase.

Known targets: production `https://niaclive.vercel.app`; candidate Preview `https://niaclive-git-feature-admin-pin-auth-zamijudes-projects.vercel.app`; gateway `https://92.4.146.91.sslip.io`. Revalidate target identities before use.

## 2. Highest risks and mandatory preflight gates

1. **Serial remote flush and reveal timing.** Approximate sustained flusher capacity is `100 / (batch HTTP seconds + 0.150)` records/second when batches are full. At 200 ms per batch this is ~286/s; at 1 second ~87/s. Intake can be healthy while backlog grows. Drain removes the normal 150 ms delay but still waits for serial remote writes. The sink currently has no explicit fetch timeout; a hung write can outlive the nominal drain timeout. Measure this before trusting a green acknowledgment chart.
2. **Duplicate durability gap.** The queue's pending-commit duplicate path returns `accepted:true` before the first transaction commits. A duplicate acknowledgment followed by a transaction failure/crash could claim acceptance prematurely. Before capacity approval, add a controlled failed-commit regression and make every accepted acknowledgment wait for the same durable outcome. Do not induce a crash on the shared live VM.
3. **Cross-route ambiguity.** An answer may commit at Oracle but the response may be lost; the phone then retries through Vercel. Verify the winning option, response time and exactly-one semantics across this race, including a retry that changes its option. HTTP 409 by itself is not proof of a harmless duplicate.
4. **Rehearsal isolation is partly fixed, not hosted-proven.** Current joins persist `is_rehearsal` when explicitly requested or event rehearsal mode is on; credentials retain the flag on recovery. Snapshot scoring excludes rehearsal identities from both competitive leaderboards and assigns null ranks. Cleanup enumerates rehearsal IDs and deletes dependent legacy answers/Lens before participants. Existing `scripts/audit-rehearsal-isolation.mjs` uses a mock DB; it does not prove deployed foreign keys, cascades, real requests, or historical snapshots are clean.
5. **A shared gateway has one cached authority/session.** Preview and production cannot independently drive it concurrently. A different hostname does not isolate the gateway, database or event. Reserve an exclusive rehearsal window and confirm the gateway's `AUTHORITY_BASE_URL` points at the same Preview authority that the controller uses. Production clients must be absent. If that cannot be guaranteed, provision an isolated rehearsal instance/event before proceeding.
6. **Protection and authentication.** Preview protection can block load clients and gateway deadline callbacks. Arrange authorized automation access for both directions; do not merely authenticate the browser or runner. Never silently redirect tests to production. Verify JSON content type and deployment identity, not just HTTP 200 from an SSO page.
7. **Historical operational signals need fresh confirmation.** A prior read found gateway reachable with sink configured but red capacity/errors. That is not a current measurement. AG must confirm current health, running commit, Caddy/service limits, authority URL, queue/WAL path, TLS and Footy health. No inferred VM changes.

Existing harness limitations to address after approval, preserving AG's scripts:

- `rehearsal-baseline.mjs` accepts 200/201 joins now, but posts opaque tokens to Vercel `/api/answers` while asserting gateway fields `accepted/duplicate`. Authority returns `recorded:true`; duplicate responses differ. It reuses per-VU UUIDs and an already-open question, and can misclassify protection as missing content. It does not hold SSE connections, prove durable counts or verify isolation.
- `load/answer-spike.js` still requires 201 joins and treats 200 or 409 as successful answers. Do not use it for certification unchanged.
- The local 1,000-player script prints a success verdict without complete correctness gates. The native synthetic ladder uses memory/local sinks. Preserve them as diagnostic tools, not acceptance evidence.
- `open_question` uses stored `duration_seconds`; the baseline's requested 60 seconds is not a reliable override. The controller must read actual deadline and abort an unsuitable window.

## 3. Workload definitions

- **Participant:** registered identity with one allowed first answer per question.
- **VU:** tool execution context. One VU may make many requests; a VU is not automatically an SSE connection or an attendee.
- **Arrival rate:** planned start rate of operations, independent of server response time. Count scheduled, started and completed separately.
- **Requests/second:** observed HTTP operations, including retries and ancillary calls; never equate this with participant count.
- **Persistent connection:** one open SSE stream across rounds. With 1,000 attendees there may be ~1,000 quiet sockets even at almost zero answer RPS.
- **Burst:** bounded set of answers during a short interval, followed by quiet time and reveal work. A closed-loop test that slows its arrivals when the server slows hides overload.

Use deterministic, seeded schedules with unique run/participant/question identities. Register and establish streams BEFORE opening a question. Synchronize planned submit times to the received state/deadline, including 5–10 seconds reading time. Record scheduling delay separately from HTTP latency. Distinguish a normal mid-window cluster from a final-five-second deadline cluster.

| Scenario | Unique first attempts | Duration | Mean first-attempt RPS | With 20% retries within same interval |
| --- | ---: | ---: | ---: | ---: |
| Expected concentrated round | 1,000 | 5 s | 200 | ~240 |
| Dense round | 1,000 | 2 s | 500 | ~600 |
| Short synchronized round | 1,000 | 1 s | 1,000 | ~1,200 |
| Attendance headroom | 1,500 | 5 s | 300 | ~360 |
| Headroom stress | 1,500 | 2 s | 750 | ~900 |
| Optional overload boundary | 1,500 | 1 s | 1,500 | ~1,800 |

Actual subsecond peaks matter; retain 100 ms arrival buckets. “1,500 RPS” alone describes neither 1,500 spectators on SSE nor normal 1,000-person demand. The final row is a short deliberate stress experiment, not a requirement for continuous traffic. No same-millisecond all-socket burst is needed for the event claim.

## 4. Failure modes and scenarios

| Test | Model and assertions |
| --- | --- |
| Join/QR influx | 1,000 joins over 120 s (~8/s), then 30 s (~33/s); measure DB insertion, credentials, rate-limit behavior behind one source IP, bootstrap and first stream readiness. Do not join inside answer-burst timing. |
| SSE occupancy | Ramp to N streams over 60 s, hold 10 min; all remain live, heartbeats arrive, no memory/FD growth across disconnect cycles. Test up to 1,500 only after lower gates pass. |
| State fanout | One controller opens/transitions; measure every listener's receipt per version, checksum and question identity. Never count server write() calls as client deliveries. Measure open, lock, reveal, leaderboard and next question. |
| Quiz burst | N first attempts with balanced known correct/incorrect options, 10% then 20% duplicate retries. Include both sequential and overlapping retries, plus changed-option duplicates. One first answer per identity/question, immutable thereafter. |
| Deadline correctness | Small tagged cohort just before and after server deadline; record expected late rejections separately from overload failures. Test early/late clocks without trusting client-supplied timestamps for scoring. |
| Persistence/barrier | Observe local acknowledgment, queued state, Supabase visibility, drain, snapshot generation and reveal. Reconcile actual IDs and options, not merely aggregate counts. |
| Scoring/Top 10 | Independent reference scoring from recorded accepted rows, including tie-break time. Rehearsal Top 10 must stay absent from public rankings. Verify competitive ranking with a controlled fixture event containing non-rehearsal synthetic sentinels; never make fake competitive identities in the genuine event. |
| Post-reveal reads | N `/api/me` reads spread over 2 s, then 1 s stress. Include retry behavior and real display leaderboard reads. Verify every participant's score and null rehearsal rank. |
| Lens | 1,000 submissions spread over 10 min (~1.7/s); short 100/5 s burst. Keep one standalone `/lens/live` plus embedded Lens when that activity is selected. Two displays mean ~0.67 approved-list reads/s, not 1,000 pollers. Verify rendered update latency and real submission IDs. |
| Mixed event | SSE + repeated quiz + 2 Lens displays + background Lens at ~2/s; one admin health panel and command stream. No artificial flood of admin commands. |
| Reconnect | Disconnect 10%, reconnect with jitter over 10 s; later all N over 30 s. Match checksum/version, avoid stale reveal/options and duplicate answers. |
| Gateway unavailable | First 25/100 clients simulate blocked gateway at the generator/browser; retain Vercel/Supabase reachability. Verify 8 s answer timeout implications, fallback writes and 3–5 s polling. Progress 250/500 only if healthy. Full 1,000 fallback is a separate conditional test, not presumed safe. |
| Total gateway outage | Separately approved maintenance window or isolated gateway only. A reachable gateway with client-side blocked SSE does not test a dead authority drain target. Expect safe hold/failed reveal if durability cannot be proven; do not claim seamless full-capacity fallback. |

## 5. Tools and generator sizing

Use **open-source k6 for scheduled HTTP traffic**, **Node.js 24 for persistent SSE listeners/controller/oracle checks**, and **three real browser sessions** (admin, projector, participant) to validate browser behavior and CORS. Do not launch 1,000 browsers.

Stock k6 HTTP alone is insufficient for receipt-level SSE/fanout verification. Grafana lists `xk6-sse`; it is a viable alternative after extension/version validation. For this deadline choose the small Node SSE companion so long-lived stream callbacks cannot block HTTP VU scheduling. Both tools share one manifest and schedule. Node holds one stream for each k6 identity, ensuring they represent the same participants, and records events while k6 answers. Use a Node end-to-end client cohort for response-driven retry/fallback sequences and real browsers for the actual transport code.

Use k6 arrival-rate executors for steady join/Lens phases. Quiz phases schedule exactly N unique identities once; `iterationInTest` maps to disjoint manifest entries and absolute planned timestamps. Preallocate enough VUs for `peak arrival rate × observed request duration`, plus retries; observe `dropped_iterations`. Do not launch a VU that sequentially registers, sleeps, and answers and call that a synchronized burst. The controller orchestrates each round and exits nonzero on any hard gate failure.

Laptop read-only inspection: Intel i7-8650U, 8 logical CPUs, ~15.85 GiB RAM, only ~1.06 GiB free at inspection. This is a candidate runner, not a validated injector. Close unnecessary workloads, use Ethernet/stable internet, then calibrate locally against a lightweight mock target before any deployed run. Require runner CPU <70% sustained, at least 2 GiB available RAM, p99 schedule slip <100 ms, zero dropped iterations/socket exhaustion, and uplink <70% capacity. Record CPU/RAM/network and schedule slip throughout. If those fail, classify the run as generator-limited and repeat on a second existing machine with disjoint IDs. Never run the generator on the small Oracle host being measured.

Estimate bandwidth from measured bytes: `N × bytes/state × transitions`, plus answer HTTP/TLS and keepalive. For illustration, a 10 KB state pushed to 1,500 clients is ~15 MB outbound per transition. Measure real envelope sizes; do not assume laptop upload/download headroom from CPU specs. Two runners need clock synchronization and merged raw histograms, not averaged percentiles.

Paid tooling is not required initially. Use another available machine first; a temporary external VM is justified only if the laptop/internet is the injector bottleneck. Grafana Cloud is optional for managed/distributed execution, not necessary for 1,000 by definition. No purchases or cloud provisioning are part of plan approval.

## 6. Instrumentation and evidence

Collect a run manifest with UTC start/end, git SHAs, deployment IDs, target origins, event/session/question IDs, seed, planned traffic, actual first/duplicate/late attempts, tool versions and runner specs. Keep credentials in a separate private manifest; reports contain IDs only. No service role key in k6 clients, browser or logs.

| Measurement | Source and cadence |
| --- | --- |
| p50/p95/p99/max | Raw per-operation timing for join, bootstrap, gateway answer, fallback answer, duplicate, `/me`, Lens, admin and reveal. Keep failures/timeouts in accounting; do not report successful samples alone. |
| HTTP errors | Counts by route/status/error code: unexpected errors, intentional late/duplicate rejections, connection/DNS/TLS failures and timeouts separately. |
| Accepted/durable/lost | Client accepted receipts + local committed IDs + Supabase rows filtered by manifest IDs/session/question. An acknowledged unique answer missing from Supabase after recovery/drain is a hard failure. |
| Queue/drain/flush | `/gateway/health` once/sec; flush request latency/failures, actual oldest queued age, in-memory pending commits, SQLite queued count, Supabase visibility lag. Record start/end of lock, drain and reveal. |
| SSE | Client connected/closed/reconnected counts, received version/checksum, missing/duplicate events, receipt timestamps. Node's health count corroborates clients. |
| Fanout latency | Controller command-send → each receipt (same runner clock); also broadcast timestamp → receipt with measured clock offset/uncertainty. Do not subtract unrelated unsynchronized clocks. |
| Gateway | Existing JSON logs, Node RSS/event-loop delay, process restart count, heap trend, CPU, error code and batch timings. Keep production logging enabled. |
| Oracle/Caddy | Host available RAM/swap, service memory limit, CPU steal/iowait, open FDs, socket count, network throughput, Caddy upstream errors/timeouts and access latency. Sample 1 s where practical. Track Footy health/response baseline. |
| SQLite/disk | Queue DB/WAL/SHM sizes, free disk, disk write latency and WAL growth across rounds/soak. Read-only diagnostics; do not force checkpoints during a measured run. |
| Vercel | Function errors, duration/timeouts, invocation/concurrency evidence where available, usage delta and logs linked by request ID and test time. Separate cold startup from warmed repetitions. |
| Supabase | REST status/errors, pool acquisition/statement timeout evidence, query/lock latency, DB CPU/load/disk if exposed, connection count and states (`pg_stat_activity` aggregated), blocking queries where permitted. Never export unrelated attendee rows or query literals with secrets. |

Health metrics are incomplete: `recordReconnect`/oldest-age setters are not evidence that all paths call them. Current health error percentage is errors divided by sampled acknowledgments plus errors, not endpoint-wide HTTP error rate; `totalQueued` includes retained flushed rows. Do not confuse `status:healthy` (flusher exists) with successful sink writes. Add only missing instrumentation required for these measurements after approval. If a provider metric is unavailable on the account, label it unavailable and use logs/REST latency as indirect evidence; never report assumed zeros.

Suggested AG/operator read-only commands on the VM (confirm actual service/PID/path first):

```sh
systemctl show niac-gateway -p MainPID -p MemoryCurrent -p MemoryMax -p CPUQuotaPerSecUSec -p LimitNOFILE -p NRestarts
journalctl -u niac-gateway --since '10 minutes ago' -f
vmstat 1
df -h
ss -s
# If already installed: pidstat -rdu -p <gateway-pid> 1; iostat -xz 1
# Inspect /proc/<gateway-pid>/limits and count /proc/<gateway-pid>/fd.
# Sample sizes at the verified queue path, including -wal and -shm.
```

Do not assume the repo's Docker or systemd profile is installed. The service template is 192 MiB, one CPU quota, no service swap, 65,536 FDs. Docker declares 1 GiB/1.5 CPUs, unsuitable to assume on the historically ~956 MiB shared host. Caddy consumes additional sockets/memory: an external SSE connection generally needs a proxy upstream connection too. Reserve headroom for Footy, Caddy and OS. AG confirms actual runtime limits before testing.

## 7. Correctness gates

For each question define sets: planned valid first identities P; unique locally committed answers L; accepted-receipt IDs A; durable Supabase identities D. Track ambiguous timeout identities U separately: a timeout can still commit. Reconcile their eventual rows rather than retrying as new participants.

- With no planned late clients: all P must resolve to exactly one answer, and A must be a subset of D after drain. L must match D for the tested identities. D may include U whose response was lost; report these explicitly. Never equate successful responses plus duplicate responses with unique rows.
- Compare participant/question, option, response time and answer IDs where stable. Detect changed-option overwrites, cross-session leakage and extra rows. Gateway/fallback uniqueness is participant/question, so repeated rounds require fresh questions or fresh identities; opening the same question does not reset uniqueness.
- Duplicate attempts must preserve the first accepted payload and earn no extra points. Gateway 200/duplicate and authority 409 are different contracts; classify a 409 as a safe duplicate only after verifying a prior row for that participant/question.
- Local pending commits and durable queue reach zero before successful reveal. No revealed event before all acknowledged answers are durable. Every participant score matches an independent score calculation using actual durable response times and canonical tie rules.
- Wrong/late/no-answer gives zero; one submission cannot score twice. Test Passport cumulative and Decode separate scores, voids, tied scores and equal-time registration ties. Top 10 time is cumulative correct response time, not last question time.
- Rehearsal identities must be absent from real Passport and Decode Top 10, with null competitive ranks while personal scores can be calculated. A rehearsal-only run cannot prove public Top 10 ordering because it should produce no rehearsal leaders: use an isolated fixture event to test that separately.
- Cleanup runs only after listeners stop, round reveal completes and queue drains. Compare pre/post real-attendee ID/count/hash and score snapshots; remove only test records. Test concurrent joins and >1,000 pagination locally before relying on shared cleanup. Existing cleanup removes all event rehearsal users, not only this run, and is multiple REST operations rather than one transaction. Do not call it on a shared dataset without an approved rehearsal inventory. Historical snapshots and retained SQLite rows must be inspected; no broad SQLite deletion.

## 8. Thresholds and abort policy

These are proposed event acceptance thresholds, fixed before the first measured run. A stress-tier failure does not retroactively invalidate a lower passing tier but forbids a higher capacity claim.

| Metric | Required event gate / interpretation |
| --- | --- |
| Accepted loss, wrong score, changed duplicate, rehearsal leakage, premature reveal | Exactly zero; immediate stop on any occurrence. |
| Unexpected HTTP/transport errors | <0.5% per route/round; no unresolved valid first answers after reconciliation. ≥1% for 10 s stops new load. Report intentional negative cases separately. |
| Answer acknowledgment | Goal p95 ≤500 ms; event gate p95 ≤1,000 ms, p99 ≤1,500 ms, max ≤3 s excluding explicitly injected faults. Timeouts are failures, not discarded samples. |
| Fanout | p95 ≤1 s, p99 ≤2 s, all healthy listeners ≤3 s; zero missed final state. Receipt latency, not write-loop duration. |
| Join/bootstrap | Each p95 ≤2 s, p99 ≤4 s; all planned joins accounted for. |
| `/me`, leaderboard read | p95 ≤1 s, p99 ≤2 s; complete correct results. |
| Lens | POST p95 ≤1 s/p99 ≤2 s; visible on display ≤6 s normally (3 s poll plus latency). |
| Queue/reveal | Drain p95 ≤5 s, every drain <8 s; queue zero before reveal; reveal visible to all ≤10 s after deadline. Verify configured 10 s drain, 12 s authority call and function limits. No timeout means pass only if real times meet gates. |
| Admin commands | p95 ≤2 s except lock/drain/reveal measured separately; no conflicting concurrent commands. |
| Host | No OOM, restart, growing swap or sustained CPU >85% for 30 s. Stop if available RAM <150 MiB for 5 s, service RSS >85% of its limit for 10 s, or Footy health degrades. Tune these only from AG's verified baseline before run. |
| Event loop | Goal p95 <50 ms, p99 <100 ms; sustained >200 ms for 5 s stops ramp. Current sampled lag alone is not a percentile histogram. |
| Queue safety | Stop arrivals if depth ≥1,000 or oldest queued age >5 s for 5 s, or depth keeps rising for 10 s after arrivals cease. Single expected burst spike is not alone a lost-answer verdict. |
| Disk | Stop on SQLite IO errors, disk >85% used or <2 GiB free, sustained WAL growth with no recovery across idle rounds. |
| Generator | Zero dropped iterations; p99 schedule slip <100 ms; otherwise invalidate capacity interpretation and fix runner. |

On abort: stop new joins/answers, retain collectors/listeners, let existing accepted writes drain, preserve evidence. No automatic clear/restart/production failover. If sink errors persist or drain cannot complete, stop the session safely and give AG exact run IDs/logs. Never repeat a failed tier until cause is understood.

## 9. Supabase and Vercel pressure

`server/db.mjs` and `createSupabaseSink` use HTTPS `/rest/v1` with server service-role authorization. There is no application `pg` connection pool or one direct PostgreSQL connection per phone in these paths. PostgREST maintains database connections internally; REST requests can still exhaust its pool or wait behind locks. Supavisor/PgBouncer would matter for direct SQL clients, but inserting a new pooler into this HTTP architecture will not reduce REST calls. Investigate batch latency, query locks, PostgREST pool/timeouts, CPU and shared service connections first. Do not blindly enlarge pool sizes or add a SQL proxy.

Approximate demand (cold caches and extra retries can increase it):

| Phase | Vercel load | Supabase implications |
| --- | --- | --- |
| 1,000 joins | 1,000 POSTs plus ~1,000 bootstrap calls and initial page/API activity, spread over arrival window | Each join includes event lookup (cached per instance), settings read and participant insert; ~2,000+ REST ops before bootstrap work. No globally shared cache assumption. |
| Question open | One admin command + authority state/database work + one gateway broadcast (may retry) | Session/settings/question writes/reads; no 1,000 state DB reads on a healthy SSE path. |
| 1,000 normal answers | Approximately zero Vercel answer calls if all gateway routes succeed | At least ~10 full 100-row batches; usually more partly filled batches. Retries normally terminate locally on gateway. |
| Reveal | Deadline callback/admin action, snapshot computation, broadcast; then ~1,000 `/me` calls | Read all relevant participants/answers/questions in 1,000-row pages; write leaderboards and participant snapshots in up to 500-row batches. `/me` includes identity/session reads in addition to its snapshot, so it is not free O(1) infrastructure work. |
| Fallback | 1,000 phones at 3–5 s polling ≈200–333 `/api/state` requests/s before retries, plus any fallback answers | Per-instance read cache may help but cannot guarantee DB load. Fallback answer path performs multiple reads/RPCs instead of a shared batch. |
| Lens | N actual submission calls + 0.33 polls/s per Lens display | Participant validation, insert and approved-list reads. No assumption that every phone maintains a Lens projector. |

Budget the number of requests, response bytes, function duration and DB work per run before launch. Prefer three rounds at a useful tier over an uncontrolled RPS soak. Venue Wi-Fi is a separate operational dependency: record wired offsite generator RTT and later do a small real venue device check; do not diagnose backend overload from Wi-Fi congestion alone. Same-IP venue traffic makes application rate-limit behavior relevant even when bandwidth is not.

## 10. Environments and configuration

Local: correctness/fault injection, generator calibration and deterministic reference scores. Preview: approved serious tests with live Oracle/Supabase routes. Production: only a later explicitly approved small smoke after Preview passes; no production maximum test by default.

If Preview shares the same Supabase project/event and Oracle process, it shares capacity, mutable session state, settings and failure domain. Rehearsal flags isolate ranking identity, not control-plane actions or resource consumption. The admin rehearsal checkbox labels ordinary new joins too. Exclusive window and before/after state manifest are mandatory.

| Variable | Intended Preview value/meaning | Production value/meaning |
| --- | --- | --- |
| `PUBLIC_GATEWAY_URL` | `https://92.4.146.91.sslip.io` only in reserved shared-gateway window | Same known URL after operational confirmation |
| `PUBLIC_EVENT_URL` | Exact tested Preview origin | `https://niaclive.vercel.app` |
| `PUBLIC_APP_ORIGIN` (gateway) | Exact Preview origin for CORS; comma-separated explicit allowed origins if needed | `https://niaclive.vercel.app`; add Preview only for authorized window |
| `AUTHORITY_BASE_URL` (gateway) | Exact tested Preview origin, reachable by gateway without SSO interception | `https://niaclive.vercel.app` |

`PUBLIC_EVENT_URL` is a gateway fallback for authority URL. Lens reads `window.APP_CONFIG.PUBLIC_EVENT_URL`, but the static build does not inject this environment variable into config.js: setting it in Vercel alone does not change the QR/join link; welcome uses `location.origin`, Lens defaults to current origin. `PUBLIC_APP_ORIGIN` is consumed by gateway CORS, not authority routing. `AUTHORITY_BASE_URL` is server-to-server authority polling/deadline routing. `AUTHORITY_POLL_MS` in `.env.example` is stale; current reconciliation uses `AUTHORITY_RECONCILE_MS` (60,000 ms default) and deadline retry variables. Confirm active config rather than changing values by name.

Secrets must match where required: Vercel and gateway credential active/previous keys and gateway admin secret; Vercel participant pepper, PIN hash and admin-session secret; service role on authority/gateway only. Runner needs an admin PIN/session and optional Preview automation secret; read-only verification process alone receives Supabase credentials. Do not claim “PUBLIC_ variables must be plain Config” without inspecting Vercel metadata: classification by name alone is not evidence of an invalid value. No environment replacement commands should run until actual project/environment/branch scope and existing values are verified.

## 11. Proposed implementation and exact execution contract

**The scripts below are TO BE CREATED after approval; these commands are the agreed interface, not currently runnable instructions.** Keep AG's existing harness intact and reuse its validated helpers where appropriate. Pin Node/k6 versions and avoid embedding secrets.

| File to create | Responsibility |
| --- | --- |
| `scripts/load/preflight.mjs` | Read-only deployment/JSON/auth/CORS/authority identity/queue/sink/config checks; refuse production, missing monitoring, dirty manifest or competing session. |
| `scripts/load/prepare.mjs` | Bounded-rate joins with rehearsal flag; private identity manifest, server-side flag verification and inventory; bootstrap once per participant. |
| `scripts/load/sse-observer.mjs` | Per-identity persistent streams, versions/checksums, heartbeats/reconnects, receipt timing and bounded buffers. |
| `load/deployed-http.js` | k6 HTTP phases with unique identities and seeded schedule; gateway credential vs authority token chosen per route; custom latency/error metrics and real assertions. |
| `scripts/load/run-tier.mjs` | One controller coordinating observer, k6, actual deadline, admin actions, collectors and stop gates; optional Node fallback cohort; never simultaneous controllers. |
| `scripts/load/collect.mjs` | Health/runner metrics plus AG-supplied host samples; logs without secrets. |
| `scripts/load/verify.mjs` | Read-only paginated Supabase reconciliation and independent score/rank calculations; strict pass/fail report. |
| `scripts/load/cleanup.mjs` | Dry-run inventory then explicit execution restricted to approved rehearsal inventory, drain/closed-state checks and post-cleanup comparison. |

PowerShell setup, after scripts exist and approval:

```powershell
$env:NIAC_BASE_URL='https://niaclive-git-feature-admin-pin-auth-zamijudes-projects.vercel.app'
$env:NIAC_GATEWAY_URL='https://92.4.146.91.sslip.io'
$env:NIAC_RUN_ID='niac-rehearsal-20260922-a'
$env:NIAC_RESULTS_DIR='artifacts/load/niac-rehearsal-20260922-a'
# Supply ADMIN_PIN (or ADMIN_TOKEN), optional VERCEL_AUTOMATION_BYPASS_SECRET,
# and verification-only SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY securely.
# Never pass the service-role environment to the spawned k6 client process.
node --version
k6 version
node scripts/load/preflight.mjs --read-only
node scripts/load/prepare.mjs --participants 50 --join-rate 5 --rehearsal
node scripts/load/run-tier.mjs --participants 50 --burst-seconds 5 --duplicate-percent 10 --rounds 3
node scripts/load/verify.mjs --run-id $env:NIAC_RUN_ID
node scripts/load/cleanup.mjs --run-id $env:NIAC_RUN_ID --dry-run
# Only after reviewing the exact rehearsal inventory:
node scripts/load/cleanup.mjs --run-id $env:NIAC_RUN_ID --confirm 'CLEAR REHEARSAL DATA'
```

The coordinator internally invokes `k6 run --out json=<run-dir>/http.jsonl load/deployed-http.js` with private manifest location, phase, planned UTC start, question/session, rate/burst and participant range. It spawns `sse-observer.mjs` and `collect.mjs`, waits for N ready listeners, then opens the selected question and schedules submissions. It waits for real automatic close/reveal, verifies every round and exits before the next tier if any gate fails. Secure artifact files containing credentials; redact published results. Commit no tokens.

Before starting: admin displays correct Preview/event, rehearsal enabled, roster not frozen, approved Passport question selected but not opened, no existing open/locked question, gateway queue/pending commits zero. Open `/display`, one participant phone, and standalone `/lens/live`. Keep Vercel runtime/usage, Supabase DB/API/connection dashboards and AG's gateway/Caddy/host monitor visible. The coordinator owns question controls during the run; MC/operator only observes or aborts. Use distinct approved questions/identities and known reference options. Do not alter live question content for performance convenience.

After each run record planned/actual arrivals; eligible first requests; success/rejection/ambiguous counts; all latency percentiles; dropped iterations/schedule slip; SSE counts and receipt distributions; peak queue/oldest age; drain and reveal durations; durable set comparison; scores; resource peaks; provider usage deltas; incidents and verdict. Keep raw JSONL plus machine-readable summary and a short Markdown report. Archive diagnostics before cleanup. Restore recorded settings/authority configuration through the responsible operator, not an assumed default.

## 12. Final recommended sequence and stop point

1. Fix/prove preflight correctness risks; calibrate runner; controlled 2–5 identity fixture and hosted smoke. Confirm isolation/cleanup with a test inventory before creating hundreds of rows.
2. 50 → 100 → 250 → 500 → 750: each has SSE ramp/hold and three distinct question rounds over 5 seconds, 10% retries. Pause and verify each tier.
3. 1,000: three rounds at 5 seconds; three at 2 seconds; three at 1 second, with 20% retries. Measure final-five-second timing separately. Include post-reveal `/me` bursts and admin transitions.
4. 1,250 then 1,500: three rounds at 5 seconds and 2 seconds only if previous gates pass. Optional 1,500/1 s boundary test is separate and abortable.
5. At 1,000, 30-minute mixed soak with SSE, ~10–15 normally paced quiz rounds, background Lens and periodic reconnects. Use fresh identities when question bank repeats to respect participant/question uniqueness. Longer soak only if event duration/resource trends justify it.
6. Controlled fallback 25 → 100 → 250, then 500 if healthy; larger fallback/outage testing requires a separate decision based on Vercel/DB evidence. Confirm safe inability to reveal during a lost durability dependency rather than forcing success.
7. Review measured passing capacity, headroom and fallback operational cap. Prefer a passing 1,250/1,500 tier before claiming reliable service for ~1,000. No automatic capacity claim from this plan. Production smoke/promotion remains a separate approval.

**Stop here for plan approval. No large deployed load test, gateway restart, environment mutation or paid tool purchase has been performed for this plan.**

## References

- Repository: `server/api.mjs`, `server/db.mjs`, `gateway/server.mjs`, `gateway/lib/sqlite-queue.mjs`, `gateway/lib/batch-flusher.mjs`, `lib/snapshot-scoring.mjs`, `lib/telemetry.mjs`, `js/niac-api.js`, `js/niac-transport.js`, `js/supabase-client.js`, `gateway/systemd/niac-gateway.service`, `gateway/docker-compose.yml`, `scripts/rehearsal-baseline.mjs`, `load/answer-spike.js`, `scripts/audit-rehearsal-isolation.mjs`.
- [k6 arrival-rate scheduling](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/) and [dropped iterations](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/dropped-iterations/): schedule independent arrivals and track generator shortfall.
- [k6 extension catalog](https://grafana.com/docs/k6/latest/extensions/explore/) and [extension execution](https://grafana.com/docs/k6/latest/extensions/run/): SSE extension is available; stock HTTP tests alone do not validate streaming receipt.
- [Supabase REST API](https://supabase.com/docs/guides/api), [connection management](https://supabase.com/docs/guides/database/connection-management), [pooling and limits](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits): REST/PostgREST connection use differs from direct application SQL connections.
