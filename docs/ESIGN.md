# E-signature adapter contract

SME-029 binds one external signature envelope to an approved Job Room estimate. A current provider-role member with `job-rooms:contracts:create` may request an envelope only for the room's named-customer approval. The immutable record pins the approval, estimate identifier and version, lowercase SHA-256 document digest, provider envelope identifier, and author membership.

Exact request-key retries return the stored envelope without creating another provider request. One envelope is allowed per approval. Adapters must use authenticated provider APIs and return HTTPS signing URLs; persistence implementations must reconcile an external envelope if the local atomic write fails after provider creation.

Completion is accepted only from a cryptographically verified provider event whose envelope identifier and document digest exactly match a pending record. Only signed events advance state, timestamps cannot precede creation, and the store must compare the pending status atomically. Declines, voids, signing ceremony UX, retention, and provider-specific recovery remain adapter concerns; scheduling remains SME-030.
