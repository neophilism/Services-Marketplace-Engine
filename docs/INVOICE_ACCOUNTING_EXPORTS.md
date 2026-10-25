# Invoice and accounting exports

SME-049 issues one immutable tenant-owned invoice and balanced accounting export from a finalized commerce source and a verified tax determination. The record binds the exact source type, source identifier and revision, customer, provider, job room, currency, amounts, tax evidence, jurisdiction and issuance time.

All amounts use integer minor units. Discounts must remain below the source subtotal. The debit to accounts receivable must equal the service-revenue and tax-payable credits; a verified zero-tax determination omits the zero-value tax entry. The store must atomically revalidate the source and tax snapshots while enforcing request-key uniqueness. Exact retries return the original immutable record, while changed retries fail closed.

This contract does not calculate tax, choose a jurisdiction, file a return, collect payment, issue a refund, mutate a ledger, or transmit data to an accounting provider. Those actions require separate authorized and reviewable workflows.
