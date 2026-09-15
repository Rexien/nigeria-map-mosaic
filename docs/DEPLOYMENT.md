# Deployment and rollback

## Before deployment

1. Create a staging Supabase project or a database backup/restore point.
2. Run the legacy `schema.sql` only for a new database, then apply `supabase/migrations/202609090001_niac_live.sql` and `supabase/migrations/202609140001_snapshot_scoring.sql` in order through the Supabase migration workflow.
3. Rotate the previously committed anon key after the migration closes the legacy policies.
4. Create event-team users in Supabase Auth, then insert their UUIDs into `admin_users`. Grant the smallest suitable role.
5. Run `node scripts/import-content.mjs` to import the supplied JSON as blocked draft content. A human reviewer must replace each placeholder source and set `review_status='approved'` before use.
6. Create the passport and decode games, rounds, questions/options and one live session. Keep it in `lobby`.

## Netlify environment

Set the variables listed in `.env.example`. `SUPABASE_SERVICE_ROLE_KEY`, `PARTICIPANT_TOKEN_PEPPER` and `GATEWAY_ADMIN_SECRET` must exist only in encrypted server environments. They must never be added to `config.js`.

On Netlify, set `PUBLIC_GATEWAY_URL` to the public Caddy gateway URL and use the same `GATEWAY_ADMIN_SECRET` as the Oracle VM. On the Oracle VM, set `AUTHORITY_BASE_URL` to the Netlify site URL, `PUBLIC_APP_ORIGIN` to the public participant-site origin, and both credential secrets. The gateway polls the authority every two seconds so the deadline transition still happens when all audience clients are on SSE.

## Oracle gateway

Copy the repository and production environment file to the VM, then use either `gateway/docker-compose.yml` or `gateway/systemd/niac-gateway.service`. Do not run both. Keep port 3000 bound to loopback; Caddy is the only public listener. Verify `/gateway/health` reports `durableSinkConfigured: true`, queue depth zero and a green capacity state before opening the roster.

Deploy the feature branch to a preview first. Exercise join, recovery, pending moderation, one correct/incorrect/late/duplicate answer, reveal, leaderboard, pause/resume and both displays. Then run the rehearsal load test. Promote the immutable tested deploy to production and attach the final custom domain.

## Load test

With k6 installed and a rehearsal question open:

```text
k6 run -e BASE_URL=https://preview.example -e PARTICIPANTS=500 load/answer-spike.js
```

The script creates rehearsal identities and concentrates answer traffic into the final five seconds. Record p95 latency, error rate, accepted+properly-rejected count, duplicate integrity and database resource use. No capacity claim is valid until the target environment passes an organiser-agreed threshold.

## Rollback

1. Pause the session; do not open another question.
2. In Netlify, publish the prior immutable deploy.
3. Keep the additive database tables in place; the old static site can ignore them.
4. If database rollback is essential, restore the pre-migration backup to a separate project and repoint the prior deploy. Do not drop the NIAC tables in-place during an event.
5. Export answers and audit logs before any post-event data correction.
