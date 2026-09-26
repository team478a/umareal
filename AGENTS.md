# Development rules

## Permanent safety and delivery rules

Read docs/SPEC.md and docs/DECISIONS.md before changing behavior. Read the feature-specific document for the area being changed, and work one reviewable phase at a time. Authorization recorded for an older phase does not authorize a new production rollout, live credential test, or unrelated feature change.

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

## Current delivery phase

Use the active user request and its named phase document to determine scope. Keep merged `main`, work that exists only in a branch or pull request, CI-verified behavior, and behavior still awaiting real-environment or device verification clearly separated. The current maintainability audit and its deferred refactoring proposals are tracked in `docs/MAINTAINABILITY_AUDIT.md`; they do not authorize business behavior changes or production deployment.
