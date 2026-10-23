# Payment abstraction and Stripe Connect

SME-038 introduces one engine-owned payment-intent contract and a narrow Stripe Connect adapter boundary. A customer may create an intent only for an active Job Room that they own, using the exact active connected account bound to that room's provider organization. Amounts are positive bounded minor units with an uppercase ISO-style currency code; floating-point major-unit money is not accepted.

The processor adapter receives a tenant-scoped opaque intent identifier, the Job Room identifier, a destination account reference, and the request key as its idempotency key. The adapter must use Stripe Connect's server-side API, keep credentials and client secrets outside engine records, disable redirects, and return only the bounded fields in `ProcessorPaymentIntent`. A response whose account, amount, currency, processor, reference, or status does not match the request is rejected.

The store must enforce uniqueness for `(organization_id, request_key)`, `payment_intent_id`, and the processor intent reference. Processor idempotency and durable request-key replay bridge retries when the provider succeeds before local persistence. Reusing a request key with any different amount, currency, room, account, customer, or provider fails closed.

This unit creates intents only. It does not calculate marketplace fees, capture deposits or milestones, accept off-platform payment records, issue refunds, resolve disputes, move payouts, or reconcile processor events; SME-039 through SME-042 own those capabilities.
