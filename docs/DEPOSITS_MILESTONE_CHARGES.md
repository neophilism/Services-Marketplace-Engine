# Deposits and milestone charges

SME-040 executes an immutable ordered charge schedule only after binding the exact active Job Room, customer, provider, accepted price quote, authorized payment intent, currency, and total. Sequence zero is the deposit; every later installment is tied to an accepted, non-reversed milestone and cannot run before the preceding charge succeeds.

The store must atomically claim a unique `(organization_id, charge_schedule_id, sequence)` and `(organization_id, request_key)` before the processor call. A claimed charge uses the same opaque request key for its local charge identifier and Stripe Connect idempotency key. Retries may resume a pending claim or replay a succeeded claim only when every immutable field matches. Completion is a compare-and-set from the exact pending claim to the validated processor result.

The processor adapter keeps credentials and client secrets outside engine records and returns only bounded capture fields. Account, intent, amount, currency, charge-reference, or status mismatch fails closed. This unit does not accept external payment records, refund or reverse a charge, move payouts, or reconcile webhooks; later Commerce units own those operations.
