# Development rules

Read docs/SPEC.md and docs/DECISIONS.md before changing behavior. Work one phase at a time. The user authorized Phase 2 through final-prediction publication and Phase 3A through Phase 3D LINE notification operations. Live credential verification, production deployment, LINE Login, results/statistics and external billing remain outside this slice.

- Never update/delete a published prediction version, its frozen marks/bets, or audit history. Corrections append a new version before the server-side deadline. Phase 2 must enforce this in PostgreSQL, not just application code.
- Authorize API responses and mutations by server-owned role, MFA assurance and race assignment. Never trust a role sent by a client or Supabase user metadata.
- Admin and expert actions require AAL2. Local authentication must reject NODE_ENV=production and bind only to loopback.
- Use UUIDs, integer yen, UTC database timestamps, JST operational dates, and exclusive entitlement end timestamps.
- Never log tokens, password/reset/MFA secrets, database URLs or payment information. Do not commit .env or .local.
- Preserve old predictions and losing predictions. Do not choose business policies silently; record pending choices in DECISIONS.md.
- Registration requires adult confirmation and versioned terms/privacy consent. Draft consent is for development only.
- No betting execution, purchase proxy, custody of money, prediction AI or automatic bet generation.
- Run generation/shared-package builds, typecheck, lint, unit tests, meaningful database/API integration tests, applicable E2E and build. Do not disable tests to pass CI.
- Report implemented behavior, test evidence, limitations and next phase. Keep production rollout separate from local delivery.
- No subagents are required for this repository.
