# Tenancy boundary audit logs

`authorizeAndAuditOrganizationAction` combines the organization RBAC decision with a structured append-only audit event. Every evaluated action records an opaque event ID, integer timestamp, action, subject and tenant context, resource tenant, and authorized or denied outcome. Missing subject or tenant context is represented as `null` rather than invented identifiers.

The sink is an injected durability boundary. Invalid event metadata or an unavailable sink denies an otherwise authorized action, so protected side effects never proceed without their authorization decision being durably recorded. Production adapters must provide collision-resistant event IDs, an append-only durable sink, restricted audit-reader access, retention controls, and monitoring for sink failures.
