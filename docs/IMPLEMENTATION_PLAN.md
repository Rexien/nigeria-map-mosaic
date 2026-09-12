# NIAC Live implementation plan

1. Preserve the map, phrase aggregation and legacy data through tests and an additive migration.
2. Introduce anonymous participant tokens and hashed recovery codes behind a server API.
3. Make lens submissions approval-first and add authenticated moderation/export.
4. Add database-backed quiz content, an explicit host-controlled state machine and atomic server scoring.
5. Build mobile participant, passport, projector and control-room experiences around the same safe state API.
6. Keep Decode the State scoring separate and seed all generated facts as `REQUIRES HUMAN FACT CHECK`.
7. Add unit/integration route tests, a configurable final-five-seconds load scenario, deployment, rollback and operator guides.

The feature branch is `codex/niac-live-2026`.
