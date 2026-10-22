# Services Marketplace Engine

Standalone, industry-agnostic services marketplace engine supporting providers, identity, marketplace discovery, Job Rooms, payments, subscriptions, advertising, AI assistants, podcasts, trust and analytics. **Only active development target until engine complete.**

Read `AGENTS.md`, `docs/DEVELOPMENT_PLAN.md`, `registry/prs.json`, `architecture/decisions.json`, the accepted ADRs in `docs/adr/`, and `docs/ENGINE_COMPLETION_CONTRACT.md`.

## Workspace bootstrap

The strict TypeScript project is split into an industry-neutral contract package plus API and worker adapters. Install the locked dependencies with `npm ci`, then run `npm run check` to validate the development plan, compile all workspaces, and execute the contract and authorization tests. See `docs/WORKSPACES.md` for ownership and fail-closed boundary rules.

CI runs registry/static policy separately from the compiled test suite. See `docs/CI.md` for the enforced dependency, evidence, source-boundary, and text-hygiene contract.
