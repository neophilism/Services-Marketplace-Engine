# Customer profiles and saved assets

SME-011 defines an industry-neutral contract for tenant-scoped customer records and reusable saved assets. The contract does not select a database or expose an HTTP route; adapters implement `CustomerStore` and must preserve its organization filters and compare-and-swap replacement semantics.

Profile creation and updates require `customer-profile:write`, while profile reads require `customer-profile:read`. Saved-asset creation and archival require `saved-asset:write`, and active listings require `saved-asset:read`. Every decision is recorded through the existing fail-closed tenant audit boundary. Cross-tenant resource identifiers, inactive organizations or memberships, missing permissions, invalid versions, stale writes, malformed input, contaminated adapter results, and audit or storage failures all return the same non-disclosing `customer_rejected` result.

Customer and asset identifiers are opaque. Contact fields and bounded asset attributes are data, never authorization evidence. Asset attributes remain generic key/value metadata so downstream products cannot introduce industry-specific concepts into the engine contract. Adapters should encrypt sensitive fields at rest, minimize retained attributes, and enforce uniqueness for active `(organization_id, customer_subject_id)` profiles.

Saved assets have an explicit active-to-archived lifecycle. Archived records remain available to an adapter's retention policy but are excluded from active listings. Profile and asset mutations increment an immutable version; adapters must atomically compare the supplied current record before replacement to prevent lost updates.
