# NIAC completion handover for Antigravity

Updated 17 September 2026. Read the existing code before editing. This is an
existing working application, not a request to rebuild or change stacks.

## Latest checkpoint — user requested pause for Antigravity

Since the original handover, server-side media foundations were added:
- `lib/question-media.mjs` validates media URLs, gates reveal-only photographs,
  and strips identifying titles/captions/source links while voting.
- `lib/state-envelope.mjs` uses that helper, retains title/fallback, and suppresses
  questions in paused/unknown states as well as lobby/preparing/ended.
- `scripts/dev-server.mjs` shares the sanitizer for HTTP and SSE; this also carries
  the current Decode text clue into SSE instead of dropping it.
- `netlify/functions/api.mjs` maps optional `media`/`image_fallback` DB fields into
  the sanitizer. Server-side `select=*` tolerates the old schema before migration;
  raw rows must never be sent to participants.
- Additive migration `202609170001_question_media.sql` is WRITTEN ONLY, NOT APPLIED.
- Four new media tests passed with transport/routes tests (25 total in that run).

**Still unfinished:** projector photo rendering, participant attribution/fallback
UI, admin media editing, importer/media asset promotion, approved bank import,
all new Decode implementation and public deployment. No visual UI changes were
made in this checkpoint. No live content/DB/server deployment was changed.
Next implement and visually verify actual media rendering on phone/projector,
then complete content/Decode and deployment gates below. Do not mistake the new
sanitizer for a completed media feature. The frontend-design skill was read in
preparation, but layout implementation had not started when the user paused.

When packaging the gateway for another isolated test, include the new
`lib/question-media.mjs` dependency; the earlier remote bundle lacks it.

## Outcome the user wants

Finish Passport Trivia and the new photo-based Decode the State, preserve the
approved Nigerian passport-inspired visual direction, and deliver a tested public
link. Hosting must stay free unless the user explicitly approves spending.
Protect the existing Footy AI service. Do not call an untested deployment ready
for thousands of players.

## Start here

- Workspace: `C:\Users\ZBOOK\OneDrive - COVENANT UNIVERSITY\Attachments\Desktop\nigeriamapmosaic`.
- Run `git status --short` and inspect changes. Existing CSS/app changes belong
  to the user's ongoing work; do not reset them.
- Read `review/README.md`, `docs/VM_CAPACITY_REHEARSAL.md`, current deployment and
  capacity runbooks, and applicable AGENTS instructions. Some older runbook
  details may be stale; verify them against implementation.
- Native Node works (`v24.10.0`). Use `node --test`; npm CLI was broken locally.
- If Git reports unsafe ownership, use a per-command safe.directory argument;
  do not change global Git configuration unnecessarily.
- Cohesive conventional commits, not one commit per file or artificial counts.
- Do not print, commit, or transfer `.env` or service-role credentials in reports.

## What is actually complete

1. Existing app has participant, admin, projector, gateway, persistence and scoring
   code. These must be inspected and reused, not assumed production-deployed.
2. Local Passport content-review tool: `node scripts/review-server.mjs`, then
   `http://127.0.0.1:4175/review/index.html`. It is isolated, not the live game.
3. `review/source-bank.js`: 24 questions transcribed from the supplied Word file.
   `review/draft.js`: proposed revisions. `review/render.js` and screens provide
   phone/projector previews with illustrative scores and paused timers.
4. Six photographs downloaded under `review/assets/`, attribution/licences in
   `review/assets.js`: adire, puff-puff, Nok, danfo during questions; suya and
   hibiscus only on reveal. Do not reveal identifying captions early.
5. No import of these drafts into production questions has been completed.
6. No implementation of the newly discussed three-photo Decode flow is complete.
7. No public NIAC gateway deployment has been completed.
8. Netlify deny rules now cover `/review/*`, `/exports/*`, `/docs/*`, `/gateway/*`
   and `/.git/*`. Test verifies configuration, not the hosted behavior. Prefer
   an explicit public-output allowlist build before release; root publishing is
   fragile. Keep public media outside the blocked review folder when integrating.

## Passport: finish content and wire it into the real game

- User's source: `C:\Users\ZBOOK\Downloads\SCIN_Independence_Day_Passport_Trivia.docx`.
- Review all 24 drafts, independently check facts and distractors with credible
  sources. The preview is NOT a complete independent fact-check.
- User wants clear wording, not a forced jokey voice on every question. Balance
  easy/medium/hard and topics; do not turn every question into an image question.
- Preserve two days, 12 questions each and balanced A/B/C/D answer distribution
  unless a justified change is shown in review.
- Keep a reviewable diff/preview before replacing live content; obtain sign-off
  on materially new questions. Do not silently publish a new bank.
- Integrate media metadata through content, DB migration if necessary, admin
  editor, API/state envelope, participant and display. Public payloads must not
  contain correct option, explanation or reveal-only media before reveal.
- Move approved media to a public assets folder, retain credits/licences, verify
  neutral alt text and photo captions do not give away answers.
- Images must work locally, with text fallback and without layout jumps; preserve
  full useful image composition. Do not hotlink or use generated 'evidence' photos.

## Decode: agreed direction and candidate rounds

Use three progressively revealing real photographs. Admin advances clues at the
MC's request. No voting while clues are appearing. Once all three are shown,
admin opens voting: four state choices, written A–D buttons and a Nigeria states
map. Phones accept answers; projector guides the MC/audience. Deadline closes
answers automatically; reveal state, image labels, explanation and updated scores.

Candidate set from discussion (still requires source/asset verification):

| State | Clue 1 | Clue 2 | Clue 3 |
| --- | --- | --- | --- |
| Ogun | Adire production | Ojude Oba | Olumo Rock |
| Kano | Dala Hill | Historic city wall/gate | Kofar Mata dye pits |
| Niger | Kainji Dam | Gurara Falls | Zuma Rock |
| Anambra | Igbo-Ukwu bronze | Ogbunike Caves | Niger Bridge, Onitsha perspective |
| Cross River | Agbokim Falls | Obudu mountain landscape | Calabar Carnival |
| Lagos | Lekki Conservation canopy | National Theatre | Eyo |

User explicitly chose Lagos over Bauchi. Niger replaces Kogi. Do not claim
shared geography is unique: Niger Bridge also connects Delta; verify exact
photograph location and attribution. Swap ambiguous clues after evidence-based
review. Source each of the 18 required photographs with reusable rights, author,
source URL, licence URL and meaningful neutral alt text. None of those 18 assets
has been confirmed as sourced for these rounds yet. Existing Passport assets may
be reusable only where the actual clue/photo fits.

- Existing `data/nigeria.geojson` is a country outline, not a full state map.
  Obtain verified state boundaries or a suitable licensed state SVG; include FCT
  correctly without calling it a state. Keep text choices as accessible fallback.
- Existing Decode clue-based 3/2/1 scoring does not fit voting only after clue 3.
  Explicitly decide/document equal points for correct answers with speed tie-break;
  do not silently retain a scoring rule that no longer matches the game.
- Passport currently uses correctness points with response speed as a tie-break,
  not an assumed speed bonus. Confirm actual code before displaying score rules.
- Extend current state machine, schema and controls rather than adding a separate
  mock-only game. Reconnect at every clue/voting/reveal state must recover safely.

## Interaction and visual requirements

- Initial lobby shows no question. Admin runs controls in background; MC uses
  the projected screen and should not need to operate the admin interface.
- Passport: one clear Open Question action publishes and starts countdown.
- Timer expiration must authoritatively lock and reveal, not rely on a player's
  browser staying open. Sync main screen and phones, then update scores.
- Players see their own score and clear correct/wrong/missed/late/duplicate states;
  projector shows top ten. Do not imply a failed network request was accepted.
- Preserve selection during pending/retry; retry idempotently. Avoid click handlers
  being lost through rerenders. Reconnect and degraded mode must be obvious.
- User prefers textured Nigerian passport-style visual character, not bland white
  or overly cartoonish redesign. Remove 'answers received' from projected design.
- Full-width top/bottom decorations; no question/timer/options/explanation overlap.
- Test phones 320/360/390/430 px, tablet portrait/landscape, projector 1280×720 and
  1920×1080, long questions/options, every reveal outcome, slow/missing images.

## Hosting and actual measured capacity

Keep Netlify frontend + existing Node gateway + Supabase architecture unless a
concrete blocker requires a decision. No speculative switch to Vercel/Neon/Redis.

User-confirmed existing website: `https://nigeriamapmosaic.netlify.app/`.
The previously observed `https://nigeria-mosaic.netlify.app` configuration is
stale; inspect and correct relevant origin settings before deployment. The user
does not know of any separate domain or gateway HTTPS setup. Do not ask them
to perform unexplained server configuration: inspect available access first,
then guide only the account/DNS actions that genuinely need their involvement.
The site deployment linkage and live gateway remain unverified. Local `.env` has Supabase
configuration; do not expose values. No confirmed Netlify project linkage/token
or gateway domain yet. Ask only for missing access/domain or use authenticated
provider UI. User is willing to provide needed details, but needs plain English.

VM SSH: `ubuntu@92.4.146.91`; existing key `C:\Users\ZBOOK\.ssh\id_ed25519`.
Do not print/read key contents or bypass SSH host-key checks. Ubuntu22.04, 2 vCPU,
~956 MiB RAM, ~355 MiB initially available, 2 GiB swap. Footy service `eplbot`
and scheduled jobs share it. No global Node/Caddy/Docker installation was present.
No existing HTTPS gateway/domain. Cloud ingress rules remain unverified.

Protected VM test completed using `scripts/vm-capacity-rehearsal.mjs`:
- Real SSE and answer gateway, disk WAL and local durable sink; generator on VM.
- Shared 192 MiB hard service cap, no service swap, one CPU quota, lower priority.
- 100/250/500/1,000 players each passed three two-second answer-burst rounds.
- Worst p95 at 1,000: 116 ms. At 1,500: 2,228 ms, exceeded 2-second target and
  stopped. All 7,050 answers persisted; duplicates/late answers checked.
- Footy still active, but actual Telegram latency/job correctness not measured.
- NOT public HTTPS, real Supabase, registration, scoring, or a long soak test.
- This does NOT prove 1,000 safe in production or establish an absolute maximum.
- Remote test service stopped after threshold failure. Files remain under
  `/tmp/niac-capacity-NcV2sa0q`, including results.jsonl and temporary Node runtime.
- Full caveats in `docs/VM_CAPACITY_REHEARSAL.md`.

## Deployment sequence and safety gates

1. Finish/review content and implementation; run tests and UI checks first.
2. Inspect current Supabase schema/migrations and policies read-only. Back up
   before additive migrations. Never disable RLS to make a test pass. Never
   truncate live tables or overwrite the existing map/event as a test shortcut.
3. Verify Netlify ownership/site linkage and prepare preview deployment. Prefer
   explicit public-file build output; ensure drafts/answer banks/env/backups and
   handover docs cannot be downloaded. Verify deny behavior over deployed HTTP.
4. Ask user for a gateway hostname/DNS access if unavailable. Set up a separate
   constrained NIAC service, persistent data directory, TLS reverse proxy and
   matching server-only secrets. Do not copy a development env blindly. Resolve
   exact port from code/config (older docs say 3000; server default is 4180).
5. Verify 80/443 cloud ingress safely; keep internal gateway loopback-only. Do
   not change SSH or Footy/firewall settings blindly. Public rpcbind111 was noted:
   investigate with user before unrelated security changes.
6. Confirm same issuer/credential secrets, allowed origin, PUBLIC_GATEWAY_URL,
   AUTHORITY_BASE_URL, correct durable Supabase sink and auth/RLS boundaries.
7. Rehearse isolated event data end-to-end: join/recovery, correct/wrong/late,
   retry/duplicate, manual clue progression, automatic close, queue drain,
   scoring/top10/personal rank, reload, reconnect, admin session expiry.
8. External load generator from another machine against actual HTTPS path:
   100→250→500→1,000 and higher only if safely passing. Include registration
   spikes, answer bursts, real DB flush/scoring, reconnect storm and longer soak.
   Log p95/p99, failures, broadcast lag, answer integrity, drain lag, CPU/RAM/swap
   and Footy responsiveness. Stop if host/Footy is affected. No paid resources.
9. Choose admission cap WITH headroom from measured complete-system results.
   If needed, provide explicit spectator/waitlist mode, not silently lost answers.
10. Promote only tested deployment; give user player/admin/projector links plus
    simple run instructions. Keep prior Netlify deploy for rollback, leave DB
    migrations additive, and never destroy accepted answers during rollback.

## Definition of done / report honestly

Approved questions and legal assets live in both games; phone/projector/admin
flow tested; no premature answers; isolated public rehearsal passes chosen cap;
Footy protected; secrets private; rollback and basic operator instructions exist.
Report exactly what was tested and outstanding, not 'all done' based on unit
tests or a local preview alone. User's PC should not need to stay on once frontend
and gateway are genuinely deployed.
