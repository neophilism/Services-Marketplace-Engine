# Outbox queues and idempotency

SME-009 defines the industry-neutral boundary between an authorized command and asynchronous delivery.

## Producer contract

Every enqueue attempt first uses the organization RBAC and durable audit boundary. The caller must hold `outbox:enqueue` for the exact resource organization. Missing context, cross-tenant access, unavailable audit storage, invalid metadata, or unavailable outbox storage returns the same non-disclosing rejection and does not continue.

The storage adapter must atomically enforce uniqueness on `(organization_id, idempotency_key)`. A repeated key in one organization returns the original message ID without inserting another message; the same key in another organization is independent. The domain record is immutable after enqueue.

## Worker contract

Workers claim one available message under a bounded lease and receive the message ID as the consumer idempotency token. Delivery is acknowledged only after the handler succeeds. Handler failure schedules a durable retry while attempts remain and moves the message to a dead-letter state at the configured limit. Stale lease tokens, malformed claims, and storage failures fail closed.

Production adapters must implement claim, acknowledgement, retry, and dead-letter transitions atomically. Handlers remain idempotent because a worker can fail after an external side effect but before acknowledgement. Operators should alert on repeated storage failures, expired leases, and dead-letter growth.
