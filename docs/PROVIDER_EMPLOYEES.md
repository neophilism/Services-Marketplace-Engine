# Provider employees and permissions

SME-013 defines tenant-bound provider employee invitations, lifecycle transitions, reads, listings, and catalog-bounded permission replacement. Provider permissions are distinct from organization RBAC: organization authorization decides who may administer a provider, while the stored provider permission set constrains what an active provider employee may later do inside that provider boundary.

Invitations require `provider-employee:write` and begin in `invited` state. Employee reads use `provider-employee:read`; replacing the complete permission set requires the separate `provider-permission:grant` capability. Permissions must match the injected, deployment-controlled catalog, use `resource:action` syntax, and are de-duplicated and sorted. Empty or unknown grants fail closed.

Allowed lifecycle transitions are invited to active or revoked, active to suspended or revoked, and suspended to active or revoked. Revocation is terminal. A suspended provider still permits employee suspension or revocation, but cannot accept invitations, grants, or employee activation. Later onboarding and attestation units remain responsible for provider activation itself.

Every authorization decision is durably audited. Single-employee operations require the expected provider organization ID and reject a record bound to any other parent. Store adapters must filter by organization, enforce one non-revoked employee per provider and subject, and atomically compare current records on replacement. Cross-tenant or mismatched adapter results, stale versions, invalid transitions, unknown permissions, inactive parents, audit failures, and persistence failures return the same non-disclosing `provider_employee_rejected` result.
