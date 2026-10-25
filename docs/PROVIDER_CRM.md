# Provider CRM contract

SME-050 provides a tenant-bound provider CRM write contract for one relationship between an active provider organization and an active marketplace customer.

Each accepted mutation records a versioned stage, optional active provider-operator assignee, normalized tags, and an immutable activity event. The store must commit the current-record comparison, provider/customer uniqueness, request-key uniqueness, replacement record, and activity atomically.

The contract requires an audited active tenant membership with `provider-crm:write`, then independently binds the acting operator, assignee, provider, customer, existing record, and replay evidence to the same tenant and provider. Stale versions, contaminated records, reused request keys with different input, invalid identifiers, duplicate tags, audit failures, and persistence races fail closed.

This unit stores operational relationship state only. It does not send messages, run campaigns, calculate funnel analytics or attribution, ingest free-form sensitive notes, or change customer/provider source records. Those concerns remain with later planned units and adapter boundaries.
