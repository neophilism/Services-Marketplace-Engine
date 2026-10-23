# Scheduling holds, conflicts, and ICS

SME-030 creates short-lived appointment holds only after a provider-role Job Room member has a signed contract for the same active room. Every hold pins the tenant, request key, room, signed envelope, provider membership, bounded interval, expiry, and printable ASCII summary. Exact retries return the stored hold; changed retries fail closed.

The scheduling store must atomically create a hold only when the provider membership has no overlapping confirmed interval or unexpired hold. A database implementation should use one transaction with an exclusion constraint or equivalently serialized conflict check. Expired holds do not block later work, but they cannot be confirmed. Confirmation is an atomic compare-and-set from `held` before both expiry and start time; a lost race or persistence failure is rejected.

Confirmed holds return deterministic RFC 5545 calendar text with UTC timestamps, escaped summaries, stable opaque UIDs, CRLF endings, and folded ASCII lines. ICS files contain no customer identity or contract document material. Calendar delivery, cancellation, rescheduling, recurring appointments, time-zone display, and technician task assignment remain adapter or later-unit concerns.
