# Availability and appointment slots

SME-020 defines a bounded, tenant-authorized availability contract. Schedule writes bind an active provider and a published service to one finite set of UTC half-open windows. Windows are normalized, non-overlapping, limited to 64 entries, and coupled to a slot duration, minimum notice period, and booking horizon. Updates use optimistic versions and refresh the canonical service revision.

Slot reads verify the provider, service, current service revision, schedule, authorization, and audit boundary before returning candidates. Projection starts at each window boundary, uses integer millisecond arithmetic, applies notice and horizon limits, excludes every overlapping tenant-bound busy interval, returns at most 500 slots, and preserves deterministic chronological order. A slot is a read-only candidate, not a reservation.

Malformed timestamps, overlapping windows, stale revisions, inactive parents, duplicate or cross-tenant busy records, audit failures, and store failures are rejected closed. The public projection exposes only schedule identity/version, canonical parent keys and exact slot bounds.

This unit does not implement leads, notifications, appointment holds, conflict arbitration, calendar recurrence, time-zone conversion, ICS, bookings, payments, or a user interface. Lead creation belongs to SME-021; durable holds, conflicts, and ICS belong to SME-030.
