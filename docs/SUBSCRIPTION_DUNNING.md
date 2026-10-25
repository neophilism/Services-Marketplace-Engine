# Subscription dunning

SME-048 records verified scheduled-charge failures into one tenant-owned, revision-fenced dunning case. It binds the subscription, customer, billing amount, currency, scheduled charge, provider event, and active dunning-policy revision before computing retry and grace timing.

The first accepted failure fixes the grace-period end. Later failures must advance the exact case revision under the same policy snapshot. Retry delays are positive, strictly increasing, bounded, and limited to five attempts. A retry is scheduled only before the fixed grace boundary; otherwise the case becomes exhausted.

The store must atomically revalidate the subscription, policy, current case, and unique verified provider event while enforcing request-key uniqueness. Exact customer-bound retries return the original case. Changed retries, stale revisions, canceled subscriptions, unverified or contaminated events, audit failures, and failed atomic writes are denied.

This contract does not charge a payment method, send a notification, cancel a subscription, revoke an entitlement, forgive debt, or make a collection decision. Those remain separate authorized and reviewable workflows.
