# Saved providers and repeat requests

SME-024 defines a tenant-bound customer convenience contract. A saved provider is an immutable relationship between one active customer profile, its authenticated customer subject, and one active provider organization. Creation is audit-gated, request-key idempotent, and rejects a second relationship for the same customer/provider pair.

A repeat request is a draft addressed to that saved provider. It can be created only by the subject recorded on the saved relationship and only when all of the following remain true:

- the customer profile and provider are active in the same tenant;
- the referenced engagement is completed and matches the saved customer, subject, and provider;
- the engagement's service is still published by that provider; and
- the optional requested window is complete, future-facing, and no longer than 366 days.

The request snapshots the current published service revision rather than silently reusing a retired revision. Exact request-key replays return the existing immutable record; conflicting replays fail closed. The contract also rejects malformed identifiers, cross-tenant or cross-customer records, inactive parties, storage failures, and unavailable authorization audit storage.

This unit stops at a draft repeat request. Invitations, Job Room membership, chat, estimates, scheduling, payments, notifications, and marine-specific behavior remain outside SME-024.
