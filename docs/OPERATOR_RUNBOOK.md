# Event-day operator runbook

## Roles and screens

- One operator controls `/admin`; a second person verifies question/reveal content.
- Project `/display` for trivia and `/lens/live` for the mosaic. Share the same projector tab through Teams.
- Participants always join at `/`; never distribute an admin URL or recovery code.

## Rehearsal

Enable rehearsal mode in event settings, join with several phones, run a complete question through lobby → prepare → open → lock → reveal → leaderboard, test a reconnect, approve and hide a lens response, and verify both displays. Clear only rehearsal-tagged participants after confirming the export.

## Live trivia

1. Select the activity, round and fact-checked question before entering `preparing`.
2. Confirm the projector shows no correct answer.
3. Open the question. The server starts the configured duration.
4. Watch connection and response counts. The host manually locks; there is no automatic progression.
5. Reveal only after lock. Show the leaderboard when appropriate, then prepare the next question.
6. Void a faulty question rather than editing it after answers exist. Record any score correction reason.

## Lens moderation

Pending is the default. Approve positive, event-suitable phrases; make only obvious spelling corrections; reject unsuitable entries; hide an approved response when necessary; restore by approving it again. Multi-word phrases remain one mosaic unit.

## Incident handling

- Network interruption: pause, keep the current question unchanged, restore connectivity, then resume from the stored state.
- Projector problem: participants can remain connected; pause before changing equipment.
- Wrong question: lock it, void it, explain the correction, then proceed. Never edit the correct option after answers arrive.
- API/database problem: pause and retain all screens. Do not announce acceptance unless the participant screen says the server confirmed it.

## Close

End the live session, export results and audit logs, capture the final top tens, and follow the retention schedule.
