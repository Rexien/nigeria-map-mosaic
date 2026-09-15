# Architecture Decision Record (ADR): Live Capacity Gateway & Snapshot Delivery

- **Status**: Implemented in code; hosted deployment and capacity validation pending
- **Date**: 2026-09-14
- **Branch**: `antigravity/niac-live-resilience`
- **Context**: NIAC Live 2026 Interactive Audience Engagement with unknown turnout; 100, 500, 1,000 and 2,500-player rehearsal tiers

---

## 1. Context & Problem Statement

NIAC Live is a synchronized, high-stakes live audience engagement application designed for Shell Companies in Nigeria. Participants join on mobile phones to answer trivia questions (Naija Passport Challenge, Decode the State, and Nigeria Through Your Lens) displayed on a main auditorium big screen.

Architecture review and local simulations identified three likely failure modes in the original serverless/Supabase path. These figures describe the modeled traffic shape, not a completed hosted production test:

1. **Read Amplification Collapse (State Polling)**:
   - 1,000 participant phones polling `/api/state` every 1.5s produced **~666 HTTP requests/second** continuously.
   - This traffic could exhaust starter-tier function and database capacity; the exact limit must be measured on the deployed accounts.
   - Each uncached state poll triggered multiple Supabase queries, creating avoidable database amplification.

2. **Write Spike Collapse (Row Lock Contention)**:
   - During the final 5 seconds before answer deadlines, ~1,000 answers arrived simultaneously.
   - The baseline RPC `submit_quiz_answer` executed:
     ```sql
     SELECT * FROM live_sessions WHERE id = p_session_id FOR UPDATE;
     ```
   - Concurrent transactions would compete for the same row lock, creating a serialization bottleneck and elevated timeout risk.

3. **Leaderboard Table-Scan Collapse**:
   - Immediately upon answer reveal, all 1,000 phones simultaneously queried `/api/me` to display individual scores and ranks.
   - In the baseline, `/api/me` queried `score_totals` for *all* participants and dynamically sorted the entire attendee population in memory to compute individual rank.
   - 1,000 concurrent `/api/me` invocations equaled **1,000,000 row evaluations** across 1,000 serverless functions.

---

## 2. Decision: "Broadcast Once, Ingest Once, Compute Once"

The implementation adds a dedicated Oracle Cloud Infrastructure gateway (Node.js 24 + Caddy) while retaining Netlify and Supabase as the authoritative circuit-breaker fallback. Deployment and production-shaped rehearsal remain required.

```text
                             Admin / MC Cue Desk (/admin)
                                           |
                                           v
                     Netlify API + Supabase (Authority & Fallback)
                                           |
                                           | Signed state transition trigger
                                           v
            Oracle VM Live Gateway (Node.js 24 + Caddy + SQLite WAL)
             [Cgroups / Limits: 1.5 vCPU, 1GB RAM, Dedicated Disk Slice]
              /                                                 \
             / (WebSocket / SSE broadcast)                       \ (POST /gateway/answers)
            v                                                     v
    Phones + Projector                                  SQLite WAL Queue
  (connecting/live/fallback/offline)                 (Transactional Group Commits)
                                                                  |
                                                                  | Batch worker (ON CONFLICT DO NOTHING)
                                                                  v
                                                        Supabase Answers Table
                                                                  |
                                        [Barrier: Stop intake -> Drain -> Reconcile]
                                                                  |
                                                                  v
                                                       Idempotent Scoring Job
                                                                  |
                                                                  v
                                                       Leaderboard Snapshots
                                                    (Top 10 + Individual Ranks)
```

### Pillar 1: Broadcast Once (Per-Device Read Elimination)
- State transitions are broadcasted over Server-Sent Events (SSE) via the Oracle VM gateway (`/gateway/stream`).
- A state transition is generated **once**, packaged into a versioned state envelope with SHA-256 checksum (`createStateEnvelope`), and fanned out in memory to all connected devices in **$< 100$ms with 0 database reads**.
- **Secret Answer Suppression**: Correct options and explanations are strictly suppressed in public state until the MC triggers reveal.
- **Client Adaptive Transport (`js/niac-transport.js`)**: Phones maintain an active SSE connection; if disconnected, they fall back to jittered HTTP polling (3–5s) with exponential backoff and local timer countdowns.

### Pillar 2: Ingest Once (Durable SQLite WAL Group Commits)
- Replaces custom append-only files with Node.js 24 native SQLite (`DatabaseSync`) configured with Write-Ahead Logging (WAL):
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA busy_timeout = 5000;
  ```
- **Transactional Group Commits**: Answer submissions (`POST /gateway/answers`) are batched into atomic transactions flushed every 15ms or 25 answers. With SQLite `synchronous=FULL`, the HTTP 200 is returned only after the local transaction commits; hosted acknowledgment latency remains to be measured.
- **Zero Lock Contention**: No database row locks on `live_sessions`. Incoming answers are accepted locally and flushed asynchronously to Supabase in batches using `ON CONFLICT (participant_id, question_id) DO NOTHING`.
- **Crash Recovery Design**: Acknowledgments wait for a committed SQLite transaction using `synchronous=FULL`. Process-restart tests pass; VM and block-storage failure guarantees still depend on the hosting platform and must be rehearsed.

### Pillar 3: Compute Once (Reveal Barrier & Pre-Computed Snapshots)
- State transitions from `open` to `revealed` enforce a strict sequential barrier (`executeRevealBarrier`):
  1. *Stop Intake*: Session moves to `locked`, immediately rejecting new submissions.
  2. *Drain Queue*: Gateway drains all remaining in-flight answers to Supabase until queue depth equals 0.
  3. *Reconcile*: Reconciles accepted intake count against persisted raw answers count.
  4. *Snapshot Scoring*: Computes ranks, scores, cultural stamps, and Top 10 leaderboards *once* in memory.
  5. *Persist & Signal*: Writes pre-computed snapshots to `leaderboard_snapshots` and `participant_score_snapshots`.
- **$O(1)$ Single-Row Reads**: Post-reveal `/api/me` and `/api/leaderboard` queries read exactly 1 pre-computed snapshot row in **$< 1.0$ms**, eliminating full-table scans.

### Pillar 4: Server-Side Participant Credentials (`lib/credentials.mjs`)
- Participants receive an opaque, short-lived HMAC-SHA256 signed token upon joining:
  `{ participantId, eventId, isRehearsal, isSpectator, issuedAt, expiresAt }`.
- Signing secrets (`CREDENTIAL_SECRET_ACTIVE`, `CREDENTIAL_SECRET_PREVIOUS`) exist **strictly on the server**.
- **Dual-Key Rotation** supports an active and previous key so credentials can be rotated without disconnecting active participants.

### Pillar 5: Graceful Overload & Spectator Isolation
- Dynamic capacity metrics aggregator tracks queue depth, p95 ack latency, and error rate, transitioning between **Green**, **Amber**, and **Red**.
- When the backstage operator freezes the roster, new participants receive signed spectator credentials (`isSpectator: true`). The health panel supplies the decision signal; automatic admission limiting is not claimed.
- Spectator answers bypass the durable queue and database entirely and return an unscored practice acknowledgment; hosted latency remains to be measured.
- Spectators receive `rank: null` and are excluded from competitive leaderboard rankings.

---

## 3. Consequences & Trade-Offs

### Positive Consequences
- **Durable local ingestion**: Local simulations preserve acknowledged answers across process restart; the hosted 2,500-player claim remains pending.
- **Low local acknowledgment latency**: In-process results are encouraging but are not substitutes for internet, proxy, VM-disk and Supabase measurements.
- **Zero Polling Database Load**: Eliminates 1,300–2,600 queries/second of state polling load on Supabase.
- **$O(1)$ Score Reads**: Instant score and Top 10 rendering without database table locks.
- **Budget-aware**: Designed to use the existing OCI VM, Netlify and Supabase accounts. Free-tier sufficiency is not guaranteed until the hosted rehearsal ladder passes.

### Operational Trade-Offs & Mitigations
- **Oracle VM Process Lifecycle**: Requires process supervision (systemd / Docker) on the Oracle VM. Mitigated by `gateway/systemd/niac-gateway.service` with `Restart=always`.
- **Circuit-Breaker Fallback**: If the Oracle VM gateway becomes unreachable, clients automatically revert to direct Netlify API calls with jittered polling.
- **Disk Persistence**: Queue data is stored on `/app/data/answer-queue.db`. Dedicated disk slice and persistent volume mounts prevent data loss across container recreation.
