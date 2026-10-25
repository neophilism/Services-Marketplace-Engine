# Plans and entitlements

SME-043 provides organization-scoped assignment of immutable published plan revisions to active customers or provider organizations. An assignment snapshots the plan's complete entitlement set, including bounded numeric limits or an unlimited marker, so later catalog changes cannot silently alter existing access.

Every change requires `commerce:plans:assign`, an active organization membership, an exact subject, plan revision, expected assignment version, and unique request key. Assignments may use only published plan revisions. Revocation may reference a retired revision so access can always be removed. The store atomically persists the current assignment and immutable command entry; exact retries return the original result, while changed retries and stale versions are denied.

Entitlement evaluation requires the exact tenant, subject type, subject identifier, key, assignment version, effective boundary, and exclusive expiry boundary. Revoked, expired, not-yet-effective, cross-tenant, contaminated, duplicated, malformed, or missing entitlements fail closed. Catalogs are bounded to 128 unique keys and safe-integer limits.

This contract does not sell a plan, create a subscription, infer payment or processor state, prorate charges, renew access, perform dunning, or define advertising inventory. Those behaviors remain later plan units or deployment responsibilities.
