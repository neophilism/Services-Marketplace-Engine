# Credential checks

SME-017 defines an industry-neutral boundary for credential evidence and external background-check providers. The engine never stores provider payloads, raw findings or sensitive identity data. Callers supply an opaque subject reference and a clean attachment already accepted by the attachment-scanning contract.

## Authorization and consent

- Running a check requires exact `credentials:check` permission, an active tenant and provider organization, and recent explicit consent. Consent cannot be future-dated and is accepted for at most 30 days by default; deployments may configure a shorter positive integer window.
- Reading one check or listing a provider's checks requires exact `credentials:read` permission. Suspended providers remain readable for audit continuity, while new checks require an active provider.
- Every authorization attempt passes through the immutable tenant audit sink. Audit failure denies the operation.

## Adapter boundary

The engine generates an opaque check ID and passes only tenant/provider identifiers, an opaque subject reference, credential and purpose codes, the clean evidence SHA-256 digest, and consent time to the adapter. Adapters must be idempotent for the engine check ID.

The adapter result must echo the check ID, tenant, provider, subject reference and digest exactly. The engine rejects malformed, future-dated, pre-consent, expired-on-arrival or cross-tenant results before persistence. Stored records contain only bounded adapter metadata and the normalized `verified`, `review` or `rejected` outcome. A verified result with `validUntil` is projected to `review` at the exact expiry boundary without rewriting immutable evidence.

Provider adapters remain responsible for their own legal basis, identity proofing, jurisdictional notices, dispute process, retention and deletion. Those obligations cannot be inferred from a normalized engine outcome.
