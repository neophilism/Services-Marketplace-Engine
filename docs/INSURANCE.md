# Provider insurance evidence

SME-016 adds tenant-bound provider insurance evidence without introducing an insurer or storage integration. Evidence creation requires an active provider and an attachment that has already passed the SME-010 quarantine and verified scanning boundary.

## Contract

- `insurance:write` creates a draft and submits it with an optimistic version.
- `insurance:read` reads or lists evidence only inside the authorized organization.
- `insurance:review` records an approval or rejection. The submitting subject cannot review the same evidence.
- The evidence snapshots the clean attachment SHA-256 digest. Submission and review fail closed if the attachment is no longer clean or its digest changes.
- Coverage type is a bounded engine-neutral key; insurer name and policy reference are bounded opaque text.
- Approved evidence is projected as `expired` when `coverageEndsAt <= now`. The projection does not rewrite immutable review evidence or increment its optimistic version.

All authorization attempts are audited. Missing permissions, cross-tenant data, malformed adapter records, suspended providers, dirty attachments, stale versions, expired coverage, duplicate list records, persistence errors, and audit failures return the stable `insurance_rejected` result.

## Integration boundary

The engine stores references and review state only. Deployment-specific object storage, malware scanning, reviewer identity policy, insurer verification, reminders, and jurisdictional coverage rules remain adapters or later plan units. No provider calls, credentials, infrastructure, or paid resources are required by this unit.
