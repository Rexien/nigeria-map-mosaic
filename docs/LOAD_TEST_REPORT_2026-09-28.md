# NIAC Live: 1,000-player cloud rehearsal (28 September 2026)

## Verdict

The latest deployed rehearsal proved that 1,000 connected players could open a question, submit answers through the Oracle gateway, survive 10% duplicate retries, persist all accepted answers to Supabase, receive the reveal, and retrieve personal scores. It did **not** meet the self-imposed 2-second reveal p95 target: the correct answer appeared on connected screens at p95 2.767 seconds after the deadline. This is a conditional capacity result, not a blanket event-day guarantee.

Evidence: [GitHub Actions run 36423529567](https://github.com/Rexien/nigeria-map-mosaic/actions/runs/36423529567), artifact `load-evidence-1000p-run-36423529567/tier-1000-report.json`. The deployed score-read pacing change was commit `f246785`.

| Check | Observed result | Interpretation |
| --- | ---: | --- |
| Persistent clients receiving question-open state | 1,000/1,000; p95 1.205 s | Passed |
| Answers accepted and durable | 1,000/1,000 | No accepted answers lost |
| Duplicate attempts | 100/100 handled | No double award in this run |
| Answer acknowledgement | p50 0.880 s; p95 7.554 s; p99 8.156 s | Passed the 8 s test gate, but close to it |
| Gateway queue | Peak observed depth 157; final depth 0 | Drained |
| Correct-answer reveal | 1,000/1,000; deadline-to-screen p95 2.767 s | **Missed 2 s target** |
| Score snapshot ready | 7.668 s after deadline | Scores lag reveal by design |
| Personal `/api/me` reads | 1,000/1,000 first attempt; request p95 3.024 s | Passed after staggered reads |
| Personal score visible | p95 11.736 s after score readiness | Roughly 19.4 s after deadline at p95 |

The preceding clean 1,000-player run, [36420206946](https://github.com/Rexien/nigeria-map-mosaic/actions/runs/36420206946), saved every answer but only 8/1,000 simultaneous personal score reads succeeded. Staggering those reads across 12 seconds resolved that read stampede in the latest run. The earlier [36417781655](https://github.com/Rexien/nigeria-map-mosaic/actions/runs/36417781655) was also affected by approximately 7,000 accumulated rehearsal profiles, which were cleared before the clean rerun.

## What this means at the event

Players get immediate on-phone submission feedback, but confirmation of a heavily loaded answer can take several seconds. At a 1,000-player load, the correct answer reached all observed connected clients within about 2.8 seconds of the timer ending (p95), not instantly. Scores are separate: the leaderboard snapshot was ready around 7.7 seconds after the deadline; most individual phones should show their updated total within about 20 seconds. The MC should allow a short reveal/discussion beat before opening the next question. A subsequent small phone-flow fix retains a pending personal-score refresh if the next question opens during that beat; it does not change the cloud timings above.

## Limits and operational state

- This was one 1,000-player round with an 8-second answer burst and 10% duplicate attempts, not a full multi-round, all-day soak or a venue Wi-Fi test. Registration was staged by the harness, not 1,000 joins in one second.
- The chosen cloud load-test question had no image. Local browser QA independently checked all 24 Passport questions across phone/projector layouts and all 18 Decode clue images, but 1,000 simultaneous picture fetches have **not** been measured.
- The strict GitHub job was red solely because reveal p95 exceeded 2 seconds; answer durability and personal-score reads passed. Do not relabel the run as a full pass.
- After the latest run, exactly 1,000 rehearsal profiles were cleared. Production was returned to Welcome/lobby; no real attendee profiles were deleted. The final verification found 0 rehearsal profiles and gateway queue depth 0.
- The latest Vercel runtime-log query was unavailable with `ExceedsBillingLimitError`; the GitHub artifact, gateway telemetry, and durable-count assertions are the evidence for this run.
- The local `scripts/test-1000-scale.mjs` synthetic benchmark can print a clean verdict despite rejected answers under its short 2-second window. It is not certification evidence; use the cloud rehearsal report above.

## Decision

Do not redesign the answer pipeline immediately before the event. Keep the current reveal drain barrier, which protects answer correctness. Treat the ~2.8-second reveal and ~20-second personal-score update as the measured operating cadence. If the event requires a hard under-2-second reveal, investigate the drain/proxy timing and repeat a controlled cloud test before claiming that target. Run a separate static-image/CDN burst check if picture-question performance is a sign-off requirement.
