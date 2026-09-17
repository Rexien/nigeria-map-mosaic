# Protected VM capacity rehearsal — 17 September 2026

## Result

Highest passing tested tier: **1,000 simultaneous simulated players**, three rounds.
At 1,500, all answers and state updates arrived, but answer acknowledgment p95
was 2,228 ms, exceeding the 2,000 ms threshold. The harness stopped; higher
tiers were not attempted. This is not a measured absolute maximum or a public
event capacity certification.

| Players | Rounds completed | Worst answer p95 | Result |
| --- | --- | --- | --- |
| 100 | 3 | 52 ms | Pass |
| 250 | 3 | 21 ms | Pass |
| 500 | 3 | 28 ms | Pass |
| 1,000 | 3 | 116 ms | Pass |
| 1,500 | 1 | 2,228 ms | Stop: latency threshold |

All 7,050 submitted first answers were accepted and counted in the local durable
sink. Each round tested ten duplicate submissions and a post-lock submission;
duplicates were recognized and post-lock answers rejected. Every simulated
client received the open and reveal versions. Queue depth was zero after every
round. At 1,500, the slowest observed open-state receipt was 297 ms.

## Test conditions and limits

- Actual existing gateway, HTTP/SSE, disk-backed SQLite WAL queue, synchronous
  durable local SQLite sink. **Not the real Supabase sink.**
- Generator and gateway shared one Node process on the VM, loopback networking.
- 100 → 250 → 500 → 1,000 → 1,500 clients; each answer burst spread over 1.98 s.
- OS service limits: 192 MiB memory, no service swap, one CPU worth of runtime,
  16,384 file descriptors, lower scheduling priority, ten-minute lifetime cap.
- Safety guard checked host available RAM and Footy service state every two seconds.
- Highest sampled process RSS was 125 MiB; lowest sampled host available RAM was
  300 MiB. These are sampled values, not continuous peaks.
- Footy remained active after testing. Its real Telegram response latency and
  scheduled-job correctness were not measured. Host swap use changed from about
  109 MiB to 117 MiB; the test service itself was forbidden from swapping.
- Per-answer console logging was suppressed. Production logging may add overhead.
- No public listener, firewall modification, deployment, production credentials,
  or Footy configuration changes. Test service exited after the threshold failure.

The shared generator and CPU cap can constrain results; loopback networking,
suppressed logging, and the local sink can make other aspects optimistic.
Consequently neither 1,000 nor 1,500 establishes a safe production player cap.

## Required next validation

Run an external load generator against the intended HTTPS endpoint with the
real persistence path, production logging, joining/authentication, repeated
rounds, reconnections, scoring/reveal, and a longer soak. Monitor Footy latency
and resource usage as well. Only then choose a production admission cap with
headroom; do not advertise support for 3,000 based on this rehearsal.

Harness: `scripts/vm-capacity-rehearsal.mjs` (Linux; expects an `eplbot` service).
Remote artifacts retained in `/tmp/niac-capacity-NcV2sa0q` for inspection;
temporary runtime is not installed globally. Raw results: `results.jsonl` there.
