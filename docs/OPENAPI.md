# OpenAPI contract and generated SDK

`contracts/openapi.json` is the canonical public HTTP contract. It exposes the tenant-scoped resource read established by the API bootstrap, requires bearer authentication and contract version 1, and documents the same generic authorization denial used by the application boundary.

Run `npm run generate:sdk` after changing the contract. The dependency-free generator validates the required operation, authentication, version, success and denial shapes before replacing `packages/sdk/src/index.ts`. CI runs `npm run generate:sdk:check`, so a contract change cannot merge with stale generated output.

The generated client requires an HTTPS base URL, a nonempty bearer token and an injected fetch-compatible transport. It encodes tenant and resource path segments, sends the fixed contract version, rejects incomplete identifiers before network access, and reduces undocumented or malformed responses to `unexpected_response`. A `403` carries only `authorization_denied`; callers receive no resource data from a denied response.
