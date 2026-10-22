# Outbox queues and idempotency

SME-009 implements ADR-003's industry-neutral boundary between an authorized command and asynchronous delivery.

## Producer contract

Every enqueue attempt first uses the organization RBAC and durable audit boundary. The caller must hold `outbox:enqueue` for the exact resource organization. Missing context, cross-tenant access, unavailable audit storage, invalid metadata, or unavailable outbox storage returns one non-disclosing rejection.

Commands use contract version 1 and a canonical `sha256:<lowercase hex>` request digest. The storage adapter's `executeCommand` transaction must atomically persist the domain mutation, tenant-scoped idempotency record, original response, and outbox message. Repeating the same organization, key, and digest replays that response without rerunning the mutation. Reusing a key with a different digest is rejected. If the mutation rolls back, none of the idempotency record, response, or event may remain.

## Worker contract

Workers claim one available message under a bounded lease. The storage adapter's `consume` transaction must atomically apply handler-owned durable changes and record `(consumer_id, message_id)`. A duplicate delivery skips the handler and is acknowledged from that durable record. Successful processing is acknowledged only with the active lease token.

Handler failure schedules a durable retry while attempts remain and moves the message to a dead-letter state at the configured limit. Unknown contract versions, malformed claims, stale lease tokens, and storage failures fail closed. Production adapters must implement command, claim, consume, acknowledgement, retry, and dead-letter transitions atomically. Operators should alert on repeated storage failures, expired leases, digest conflicts, and dead-letter growth.
