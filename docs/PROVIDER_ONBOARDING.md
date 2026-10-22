# Provider onboarding and attestation

SME-015 defines a tenant-bound, industry-neutral onboarding workflow for activating provider organizations. Applicants require `provider-onboarding:write`, readers require `provider-onboarding:read`, and human reviewers require `provider-onboarding:review`. Every authorization decision uses the existing durable audit boundary.

An application belongs to exactly one draft provider organization. Its attestation snapshots copy the catalog key, authoritative statement text, statement version, affirmation time, and optional expiry. The catalog is bounded, all configured statements must be affirmed, and changed or expired statements prevent submission or approval. Draft attestations may be fully replaced with an optimistic application version; submitted attestations are immutable.

The lifecycle is explicit: draft applications may be submitted, submitted applications may be approved, rejected, or withdrawn, and every terminal state is immutable. Approval records the reviewing subject and bounded reason and atomically changes the application to approved while activating the provider organization. Store adapters must compare both current records in one transaction so partial approval cannot escape.

Cross-tenant or mismatched adapter records, stale versions, inactive provider state, invalid catalogs, expired attestations, audit failure, and persistence failure all return the same non-disclosing `provider_onboarding_rejected` result. Later insurance and credential evidence units may add supporting records without weakening this activation gate.
