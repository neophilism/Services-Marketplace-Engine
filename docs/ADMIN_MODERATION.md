# Admin moderation contract

SME-052 provides a tenant-scoped contract for opening and advancing administrative moderation cases. Every accepted request requires both organization RBAC and an active admin operator grant for `admin:moderation:write`. The store atomically appends an immutable action and compare-and-swaps the case snapshot.

Actions contain bounded reason codes and opaque evidence references, not copied user content or free-form case notes. Request keys support exact replay; target binding, state transitions, optimistic versions, lifecycle checks, audit persistence, and store failures all fail closed.

This unit does not store user-generated content, make automated enforcement decisions, grant cross-tenant administration, define appeals policy, or deliver notifications. Adapters remain responsible for durable uniqueness and atomic action/snapshot persistence.
