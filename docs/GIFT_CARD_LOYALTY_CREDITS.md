# Gift cards and loyalty credits

SME-047 applies one tenant-owned stored-credit source to one exact immutable customer price quote. Gift cards require an exact SHA-256 claim digest; loyalty credits are bound to the authorized customer and reject claim digests.

Applications require `commerce:stored-credit:apply`, active tenant membership, an exact active source revision, matching currency, a current source lifetime, sufficient balance, and an exact customer quote. Applied amounts use integer minor units and may not exceed either the source balance or quote subtotal.

The store must atomically revalidate the source revision and balance while enforcing unique request-key and quote constraints. Exact customer-bound retries return the original application. Changed retries, stale or frozen sources, overdrafts, expired sources, wrong customers, cross-tenant records, audit failures, and failed atomic writes are denied.

This contract does not settle payment, combine multiple tenders, issue or fund stored value, reverse charges, calculate tax, or authorize refunds. Those remain separate controlled workflows.
