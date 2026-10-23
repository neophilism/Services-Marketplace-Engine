# Lead triage and quote contract

SME-022 adds provider-specific triage and immutable quote revisions to a matched open lead.
Every command requires exact tenant RBAC, durable authorization auditing, an active provider
operator with the command permission, and a canonical match for that provider. Request keys
are idempotent: exact retries return the original record and changed-input reuse is rejected.

Triage records one terminal provider decision. Declines require a bounded machine-readable
reason; interested decisions permit quoting. Quotes use integer minor units, bounded line items,
a three-letter currency, a validity window of at most 31 days, and monotonically increasing
immutable versions. Each revision retains the prior quote identifier and the matched service
revision. The storage adapter must atomically enforce request-key and version uniqueness.

This unit does not deliver notifications, accept quotes, schedule work, sign contracts, or move
money. Those behaviors remain assigned to later plan units. Rejection is intentionally uniform
so callers cannot use authorization or adapter failures to enumerate leads or providers.
