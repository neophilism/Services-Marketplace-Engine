# Subcontractor permissions

SME-034 provides explicit least-privilege delegation for subcontractors in one active Job Room. An active provider member with `job-rooms:subcontractors:manage` may delegate a sorted, duplicate-free subset of four operational capabilities to an exact active subcontractor member: view tasks, complete assigned tasks, create work records, and read room media. A delegation expires after at most 90 days and never grants customer approval, estimate, change-order, payment, refund, or delegation-management authority.

Authorization rechecks the organization, room, subcontractor membership, active delegation, expiry, and exact requested capability on every decision. Closing the room, deactivating or rebinding membership, expiry, revocation, cross-tenant identifiers, malformed stored data, and storage or audit failures all deny access without revealing which check failed.

Tenant-scoped request keys replay only when every material grant or revocation field still matches. Revocation requires the exact provider membership that created the delegation and revision 1; the store must compare and set the delegation to revision 2 while persisting immutable revocation evidence in the same atomic operation. New authority requires a new delegation rather than mutation of an existing grant.
