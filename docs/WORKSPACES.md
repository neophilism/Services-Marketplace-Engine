# TypeScript workspace bootstrap

The engine uses npm workspaces with strict TypeScript project references:

- `packages/contracts` owns versioned, industry-neutral contracts and fail-closed tenant authorization.
- `apps/api` is the HTTP boundary and may call resource adapters only after authorization.
- `apps/worker` is the background-work boundary and may execute tasks only after authorization.

Both application workspaces depend inward on `@services-marketplace/contracts`. The contract package does not depend on either adapter or on a downstream application. Run `npm ci` followed by `npm run check` to validate the plan, compile every workspace, and execute contract and authorization-negative tests.

The bootstrap exposes contract version `1`. Unknown versions are rejected before resource lookup or task execution. Authorization failures intentionally use the same public `authorization_denied` code for missing tenant context, inactive or revoked membership, missing permission, and cross-tenant identifiers so foreign resource existence is not disclosed.
