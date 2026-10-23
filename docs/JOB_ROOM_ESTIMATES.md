# Immutable Job Room estimates and approval

SME-028 adds a tenant-audited estimate lifecycle to active Job Rooms. A current provider-role member holding `job-rooms:estimates:create` may create immutable versions with bounded line items, integer minor-unit amounts, a three-letter currency, a maximum 31-day validity window, and an exact link to the prior version. Request-key retries are exact; changed input is rejected.

Only the room's named customer subject, acting through a current customer-role membership with `job-rooms:estimates:approve`, may approve the latest unexpired version. Approval is immutable, records the exact estimate identifier and version, and is unique per room. Older versions cannot be approved, providers cannot self-approve, and no new estimate may be created after approval.

Persistence adapters must atomically enforce tenant-scoped request keys, monotonic version numbers, predecessor linkage, and one approval per room. Cross-tenant records, closed rooms, wrong roles, malformed or overflowing totals, expired estimates, replay conflicts, audit outages, and failed writes use one non-disclosing rejection. E-signatures remain SME-029; scheduling and payment remain later units.
