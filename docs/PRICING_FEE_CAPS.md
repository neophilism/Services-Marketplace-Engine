# Pricing and fee caps

SME-039 creates immutable marketplace price quotes from a versioned pricing policy. Only the exact customer for an active Job Room may request a quote, and the policy must belong to that room's provider organization. Quotes bind the tenant, room, customer, provider, policy identifier and revision, currency, and subtotal so later commerce operations cannot silently substitute a new policy.

All money uses positive integer minor units. Customer and provider fees are calculated independently as `floor(subtotal * basis points / 10,000)` and then limited by their explicit minor-unit caps. Each rate is limited to 2,500 basis points, totals must remain within the contract's bounded money range, and replay succeeds only when every pricing input is identical.

The store must enforce uniqueness for `(organization_id, request_key)` and `price_quote_id`. This unit calculates and records a quote only; it does not create or capture a payment intent, reserve a deposit, transfer a fee, or mutate a connected account.
