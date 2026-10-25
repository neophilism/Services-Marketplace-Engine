# Email, push, and SMS adapters

SME-054 defines one tenant-scoped dispatch boundary for email, push, and SMS providers. An active organization member with both RBAC permission and an active operator grant may dispatch only a pre-existing, ready notification intent within its delivery window.

Intents and adapter commands carry opaque recipient and payload references plus a normalized template key. They never carry message bodies, addresses, phone numbers, device tokens, credentials, or provider configuration. The channel chooses an explicit adapter; missing adapters, invalid provider receipts, provider failures, audit failures, and failed atomic persistence all fail closed.

The store must atomically bind one immutable delivery receipt to the tenant request key and source intent. Reusing a request key succeeds only for the exact same intent and stored delivery, without calling the provider again. Retry scheduling, dead lettering, template rendering, opt-out policy, quiet hours, provider webhooks, and credential rotation remain deployment and outbox responsibilities.
