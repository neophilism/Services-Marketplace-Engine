# Referral and affiliate controls

SME-046 records one held referral attribution for an exact customer price quote. A referral token is represented by a SHA-256 digest and is pre-bound to one active affiliate and one referred customer with an inclusive-start/exclusive-end lifetime.

Attribution requires `commerce:referrals:attribute`, active tenant membership, an exact active program revision, an active non-self affiliate, an unused customer-bound token, and a matching immutable quote. Commission uses floor-rounded integer basis points, a mandatory minor-unit ceiling, and a bounded hold period.

The store must atomically revalidate the program revision and unused token while enforcing unique request key, token, referred customer, and quote constraints. Exact customer-bound retries return the original held attribution. Changed retries, self-referrals, cross-tenant records, inactive affiliates, stale policies, expired or consumed tokens, quote mismatches, audit failures, and failed atomic writes are denied.

This contract does not release or pay commission, hold a balance, reverse a charge, issue stored value, or decide tax. Operational fraud review and payout reconciliation consume the held attribution through separate authorized workflows.
