# AI gateway quotas and tools

SME-056 defines a tenant-scoped admission boundary for reserving AI invocation capacity. An active organization member must have both the RBAC permission and an active operator grant. Each request names one configured quota, one allowlisted model, an ordered unique set of allowlisted tools, and bounded maximum input and output tokens.

The store supplies a structurally validated quota period with aggregate and per-request ceilings. Reservation advances request and token counters in the same optimistic atomic commit as an immutable metadata-only receipt. Reusing a tenant request key succeeds only for an exact replay and does not consume quota twice. Expired periods, malformed stored state, stale commits, unknown models or tools, and exhausted limits fail closed.

This contract does not execute a model or tool, store prompts or outputs, meter actual provider usage, bill customers, select models, retry providers, manage credentials, or authorize tool side effects. Deployment adapters must separately protect prompt and response content, reconcile reserved versus actual usage, enforce egress and tool-specific authorization, and preserve provider receipts. Assistant configuration and behavior are later plan units.
