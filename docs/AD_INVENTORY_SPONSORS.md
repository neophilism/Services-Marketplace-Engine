# Ad inventory and sponsors

SME-044 reserves organization-owned advertising inventory for an exact active sponsor campaign. Every reservation binds a unique request key, slot revision, sponsor, campaign, clean creative attachment, HTTPS destination, format, and bounded display window.

Reservations require `commerce:ads:manage`, active tenant membership, active inventory, current sponsor and campaign standing, matching formats, and windows contained by both inventory and campaign availability. The store must atomically advance the inventory revision and enforce slot concurrency. Exact retries return the original placement; changed retries, stale revisions, cross-tenant records, duration overflow, unclean creative evidence, and failed atomic writes are denied.

Delivery revalidates the exact tenant, slot, sponsor, campaign, creative snapshot, clean scan state, and inclusive-start/exclusive-end boundaries. Paused campaigns, suspended sponsors, changed creative, or expired placements fail closed.

This contract does not auction inventory, charge sponsors, target or profile people, track impressions or clicks, set campaign budgets, or infer consent. Pricing, attribution, privacy, and analytics remain separate plan units or deployment responsibilities.
