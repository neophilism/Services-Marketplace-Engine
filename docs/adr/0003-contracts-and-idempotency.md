# ADR-003: Versioned contracts and idempotent side effects

Status: Accepted

## Context

API retries, queue redelivery, payment callbacks, and notification delivery can repeat. Unversioned payloads and non-idempotent handlers can create duplicate jobs, charges, messages, or ledger entries.

## Decision

External requests, responses, and events use explicit supported versions and fail closed on unknown versions. Mutating commands accept tenant-scoped idempotency keys bound to a canonical request digest. Reuse with different input is rejected. Database changes and outbound events commit together through a transactional outbox; consumers record durable deduplication keys.

## Required negative evidence

Contract tests reject unsupported versions and malformed identifiers. Integration tests reject an idempotency key reused with different input, prove same-input replay returns the original result, and prove rolled-back transactions publish no event.
