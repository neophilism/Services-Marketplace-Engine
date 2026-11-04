# Assistant registry configurations

SME-057 defines a tenant-scoped, versioned registry for assistant configuration metadata. An active organization member must hold both the organization RBAC permission and an active operator grant. Each immutable revision selects an assistant key, enabled status, model key, canonical ordered tool keys, an external instruction-template key, and canonical ordered knowledge-source keys.

Writes use expected revisions and one optimistic atomic commit. Tenant request keys replay only when every requested field exactly matches the stored revision. Stored records are structurally validated before use; cross-tenant, disabled, stale, malformed, duplicate-key, audit-failure, and persistence-contention paths fail closed. Resolution returns a detached immutable active configuration.

The registry stores references, not prompts, knowledge content, secrets, credentials, provider responses, or tool results. It does not execute models or tools, authorize tool side effects, grant access to referenced knowledge, or override the AI gateway model/tool/quota boundary. Deployment adapters must resolve every reference under current tenant authorization and independently enforce the SME-056 admission contract.
