# Services Marketplace Engine

Standalone, industry-agnostic services marketplace engine supporting providers, identity, marketplace discovery, Job Rooms, payments, subscriptions, advertising, AI assistants, podcasts, trust and analytics. **Only active development target until engine complete.**

Read `AGENTS.md`, `docs/DEVELOPMENT_PLAN.md`, `registry/prs.json`, `architecture/decisions.json`, the accepted ADRs in `docs/adr/`, and `docs/ENGINE_COMPLETION_CONTRACT.md`.

## Workspace bootstrap

The strict TypeScript project is split into an industry-neutral contract package plus API and worker adapters. Install the locked dependencies with `npm ci`, then run `npm run check` to validate the development plan, compile all workspaces, and execute the contract and authorization tests. See `docs/WORKSPACES.md` for ownership and fail-closed boundary rules.

CI runs registry/static policy separately from the compiled test suite. See `docs/CI.md` for the enforced dependency, evidence, source-boundary, and text-hygiene contract.

PostgreSQL schema changes use paired transactional SQL migrations with real apply, row-level authorization, and rollback validation. See `docs/DATABASE.md`.

The canonical OpenAPI document and deterministic generated TypeScript SDK are described in `docs/OPENAPI.md`. CI rejects stale generated output.

The fail-closed passkey MFA and bounded session contract is documented in `docs/IDENTITY.md`.

Organization membership and role authorization is documented in `docs/RBAC.md`.

Fail-closed tenancy authorization audit events are documented in `docs/AUDIT_LOGS.md`.

Tenant-scoped idempotent outbox delivery and leased retry behavior are documented in `docs/OUTBOX.md`.
