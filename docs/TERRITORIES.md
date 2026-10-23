# Service territories and travel rules

SME-018 adds bounded circular service territories to active provider locations that support `mobile` service. Coordinates use integer microdegrees, distances use integer meters, and money uses non-negative integer minor units with an uppercase three-letter currency code. The engine does not geocode postal addresses or claim polygon/GIS coverage.

Creating or changing a territory requires exact `territory:write` permission and optimistic version matching. Reading and quoting require exact `territory:read` permission. New or active territories require an active provider and active mobile-capable location. Suspended providers remain listable for audit continuity but cannot receive an eligible quote.

The quote contract computes great-circle distance from the territory center, applies both the territory radius and configured maximum travel distance, and charges the base fee plus the per-kilometer fee rounded up to the next kilometer. Out-of-range destinations return an ineligible quote with no fee. All adapter records are checked for exact tenant, provider, location and identifier binding; malformed or unavailable state fails closed.

The result is an eligibility and fee projection, not a route, arrival promise, tax calculation or final price. Routing, geocoding, traffic, accessibility, scheduling and customer acceptance belong to later adapters and workflows.
