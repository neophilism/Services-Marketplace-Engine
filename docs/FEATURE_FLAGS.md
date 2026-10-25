# Feature flags configuration

SME-053 defines a tenant-scoped configuration boundary for operational feature flags. An active organization member with both RBAC permission and an active operator grant may create or revise a flag for one explicit environment.

Each configuration is an immutable revision containing an opaque request key, normalized flag and variant identifiers, a boolean state, the actor, and a timestamp. Optimistic revision checks and an atomic store boundary prevent lost updates. Reusing a request key succeeds only for an exact replay. Evaluation validates the tenant, key, environment, and complete stored record before returning the current state.

The contract intentionally excludes user-level targeting, percentage rollout, experimentation analytics, secret values, remote-code loading, cross-tenant defaults, and notification delivery. Callers must not place credentials, personal data, or free-form content in flag or variant identifiers. Deployment adapters remain responsible for durable storage, cache invalidation, availability, and authorization before exposing configurations to clients.
