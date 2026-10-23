# Lead creation and matching

SME-021 defines a tenant-scoped contract for opening a service lead, selecting a bounded
set of eligible providers, and committing one notification intent per selected provider.
It does not deliver email, SMS, or push messages and does not triage leads, create quotes,
reserve appointments, or expose customer request text in notification metadata.

## Contract

`createMatchedLead` requires the exact `leads:create` permission and records the
authorization decision before reading or writing tenant data. A request binds an active
customer profile to the current published service revision, a trimmed 2,000-character
summary, an optional future request window of at most 366 days, and a caller-selected
match limit from 1 through 20.

The injected matcher must return at most 1,000 active, eligible, tenant-bound candidates
for the current service revision. Candidate provider and recipient identifiers must be
unique. The contract rejects contaminated or malformed result sets, orders accepted
candidates by descending integer score with provider ID as the stable tie-breaker, and
keeps only the requested maximum.

The store commits the immutable lead, match snapshots, and metadata-only notification
intents as one transaction. A false result or exception is a complete rejection, so an
adapter must not leave a partial lead or notification set.

## Idempotency and privacy

`requestKey` is tenant-scoped. Replaying an exact request returns the canonical lead
without rematching or emitting notifications. Reusing a key with changed request data or
a changed service revision is rejected.

Notifications contain only opaque tenant, lead, provider, and recipient identifiers plus
the `lead.matched` event name and occurrence time. Customer summary and scheduling
details remain in the lead record. Channel delivery belongs to SME-054.

## Adapter obligations

- Resolve customer and service parents from the authorized organization.
- Derive eligibility from canonical provider/search/territory/availability data as
  applicable to the request; never return cross-tenant or stale rows.
- Implement `createLead` as an atomic transaction with a uniqueness constraint on the
  tenant and request key.
- Treat `lead_rejected` as deliberately non-diagnostic at the trust boundary and retain
  detailed operational causes only in protected telemetry.

