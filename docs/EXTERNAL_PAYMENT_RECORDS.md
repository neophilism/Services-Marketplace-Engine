# External payment records

SME-041 records bounded evidence of a payment made outside the engine. A record is tenant- and Job Room-bound and may be reported only by the exact active customer or provider participant. The reported amount, ISO-style currency, payment time, method, opaque external reference, and clean room-bound evidence attachment are immutable and exactly replayable by request key.

A reported record is evidence, not processor confirmation or a settlement instruction. The contract does not store credentials or account numbers, move money, mark a Stripe intent paid, issue refunds, decide disputes, reconcile payouts, or authorize accounting treatment. Those actions require later Commerce contracts and independent authorization.

Adapters must enforce unique organization and request-key records atomically and keep raw sensitive payment material outside engine records. Evidence that is quarantined, infected, deleted, cross-tenant, or attached to another Job Room fails closed.
