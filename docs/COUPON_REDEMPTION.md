# Coupon redemption control

SME-045 redeems an organization-owned coupon against one immutable customer price quote. Policies use a SHA-256 code digest rather than a plaintext coupon code and bind an exact revision, currency, integer discount rule, minimum subtotal, validity window, global cap, and per-customer cap.

Redemption requires `commerce:coupons:redeem`, active tenant membership, an exact active policy revision, a matching digest, and a quote owned by the authenticated customer. Percentage discounts use floor-rounded basis points and a mandatory minor-unit ceiling. Fixed discounts are capped at the quoted subtotal.

The store must atomically revalidate the policy revision, total-redemption count, customer count, unique request key, and one-redemption-per-coupon-and-quote constraint before it records the immutable redemption. Exact customer-bound retries return the original result; changed retries, cross-tenant records, exhausted limits, stale policies, mismatched currencies, inactive windows, audit failures, and failed compare-and-set writes are denied.

This contract calculates an auditable discount decision only. It does not mutate the price quote, collect payment, define referrals or affiliates, issue gift cards or loyalty value, manage subscriptions, or calculate tax.
