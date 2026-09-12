# NIAC Live repository audit

Audit date: 9 September 2026

## Existing system

The repository is a dependency-free static site deployed by Netlify. It uses plain HTML, CSS and browser JavaScript; a vendored Supabase client for persistence/realtime; D3 plus `d3-cloud` for the display; and a bundled Natural Earth Nigeria GeoJSON boundary. There was no application server, build step, test runner or authentication provider integration.

Existing routes were `/` (also duplicated as `/submit.html`), `/display.html`, and `/admin.html`. The participant submitted directly to `public.responses`; the display queried non-hidden rows and subscribed to Supabase Realtime; the admin queried all rows and changed `is_hidden` directly. When Supabase was unavailable, all three flows used localStorage demo data.

## Behaviour retained

- The authentic bundled Nigeria boundary and collision-mask word packing.
- Realtime updates and local rehearsal fallback.
- Stem-based response weighting, while treating a phrase as one display unit.
- Static Netlify delivery and Supabase as the primary datastore.
- Existing `responses` rows. The additive migration copies legacy rows into the moderated lens table and does not delete them.

## Findings

- The administrator PIN was shipped in `config.js`, so it was not authentication.
- RLS allowed every anonymous browser to read every submission and update every column.
- Moderation was opt-out (`is_hidden=false`) rather than approval-first.
- Client clocks and client-computed fields were trusted.
- There was no participant identity, recovery, idempotency, rate limiting, game state, scoring, audit log, content workflow, or separation between private answers and public display data.
- A production Supabase project URL/key was committed. The anon key is designed to be public, but the broad policies made it dangerous. Rotate it after applying the migration.
- `Access-Control-Allow-Origin: *` was applied site-wide and the CSP/security headers were incomplete.
- The UI was dark, gradient-heavy, and not aligned with the supplied white-dominant direction.

## Architecture decision

Retain the static frontend, Netlify and Supabase. Add Netlify Functions as the trusted boundary for identity, answer acceptance, moderation and control. Atomic answer acceptance/scoring is implemented in a PostgreSQL function using the server deadline. Supabase Auth protects admin operations; an `admin_users` allowlist supplies authorization. Public clients receive only safe question projections, never `correct_option`.

## Local baseline

Before editing, `/`, `/display.html`, `/admin.html`, and `/data/nigeria.geojson` all returned HTTP 200 from a local static server. No automated tests existed.
