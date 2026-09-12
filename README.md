# NIAC Live

The native interactive platform for Shell Companies in Nigeria’s Nigeria Independence Anniversary Celebration 2026: **Timeless Nigeria: Roots, Realities & Renewals**.

NIAC Live includes anonymous join and recovery, the moderated **Nigeria Through Your Lens** map mosaic, cumulative two-day **Naija Passport Challenge** trivia, separate **Decode the State** scoring, a 16:9 event display, Supabase-authenticated control room, and fact-check-gated content files.

## Architecture

- Static HTML/CSS/JavaScript participant and display clients, hosted by Netlify.
- Netlify Functions form the trusted API boundary.
- Supabase Postgres stores event, identity, content, live state, answers and audit data.
- Supabase Auth plus `admin_users` protects operator actions.
- PostgreSQL accepts answers atomically using its clock, uniqueness constraints and server-only correct answers.
- D3 and the bundled Natural Earth GeoJSON retain the authentic Nigeria mosaic.

## Routes

| Route | Purpose |
|---|---|
| `/` | Welcome, join, recovery |
| `/activities` | Participant activity hub |
| `/lens` | Moderated lens submission |
| `/lens/live` | Projected Nigeria mosaic |
| `/play` | Current live trivia activity |
| `/passport` | Personal scores, rank and stamps |
| `/display` | Projected trivia/welcome display |
| `/admin` | Protected control room and moderation |
| `/admin/content` | Question review view |

## Local checks

Node 20+ is sufficient for tests:

```text
node --test
```

Run the complete local rehearsal environment with:

```text
node scripts/dev-server.mjs
```

Then open `http://127.0.0.1:4173/`. The local control room at `/admin` receives a loopback-only operator session automatically. Rehearsal data is stored under ignored `.local-data/`; production still uses Netlify Functions and Supabase.

See [deployment](docs/DEPLOYMENT.md), [operator runbook](docs/OPERATOR_RUNBOOK.md), and [repository audit](docs/REPOSITORY_AUDIT.md).

Sample questions are not production-approved. Every generated item in `content/` is marked **REQUIRES HUMAN FACT CHECK**.
