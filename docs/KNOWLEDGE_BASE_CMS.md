# Knowledge base content CMS

SME-055 defines a tenant-scoped control plane for immutable knowledge-base article revisions. An active organization member with both RBAC permission and an active operator grant may create a draft, update a draft, publish a revision, begin a later draft from a published revision, republish, or archive the current article.

Article identity is the normalized article key plus locale. Each revision binds an opaque content reference to a SHA-256 digest, title, lifecycle state, actor, timestamp, and monotonic revision. Optimistic revision checks prevent lost updates, and a tenant request key replays only the exact stored mutation. The public read projection returns only a structurally valid published revision for the requested tenant, key, and locale.

The content object store must verify the digest and retain referenced immutable content. Rendering and sanitization, raw body storage, media, redirects, categories, navigation, search indexing, localization workflow, comments, analytics, scheduled publishing, cache invalidation, and AI ingestion are outside this contract and remain deployment or later-plan responsibilities.
