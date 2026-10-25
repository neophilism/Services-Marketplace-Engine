# Commerce reconciliation

SME-042 provides an organization-scoped, immutable reconciliation ledger for a single successful scheduled charge or reported external payment. It records verified refunds, dispute opens and outcomes, and provider payouts without claiming that this engine moves funds.

Every command requires `commerce:reconciliation:record`, an active organization membership, an exact source and expected revision, and a unique request key. An injected verifier must return the exact provider, source reference, event reference, event type, amount, currency, and payout destination. Stripe Connect evidence is accepted only for scheduled charges; external-evidence verification is accepted only for external payment records.

The store atomically persists the revised aggregate and immutable journal entry. Exact retries return the entry's original result. Changed retries, stale revisions, cross-tenant or contaminated sources, duplicate open disputes, mismatched dispute amounts, over-refunds, over-payouts, restricted destinations, audit outages, verifier failures, and compare-and-set failures are denied.

Refunds and payouts cannot exceed the unreconciled source amount. A dispute freezes new refunds and payouts until an exact verified win or loss clears it; a loss permanently reduces the available balance. Payout evidence must bind an active, payout-enabled destination for the exact provider organization.

This contract does not initiate refunds, adjudicate disputes, submit processor requests, transfer funds, infer settlement from a reported external payment, post accounting entries, or replace the independent human oversight defined by SME-036. Adapters and durable storage remain deployment responsibilities.
