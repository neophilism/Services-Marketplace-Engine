# Funnel analytics attribution contract

SME-051 records privacy-minimized, tenant-bound funnel events against an active provider CRM relationship. Accepted events advance a monotonic funnel stage and atomically update deterministic first-touch and last-touch attribution.

Every event is immutable and request-key idempotent. The store must atomically compare the current snapshot, enforce request-key uniqueness, append the event, and replace the snapshot. The contract independently binds the tenant, CRM relationship, provider operator and permission, rejects future or out-of-order events, stale versions, stage regressions and contaminated replay evidence, and stores only bounded attribution keys rather than raw URLs or personal data.

This unit does not mutate CRM records, aggregate across tenants, deliver ads or messages, manage campaigns, or provide reporting UI.
