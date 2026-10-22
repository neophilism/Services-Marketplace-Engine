# Object storage attachment scanning

SME-010 keeps every new object in an organization-scoped quarantine namespace. Clients supply metadata and a lowercase SHA-256 digest, but the engine generates the attachment ID and object key. Uploads require the exact `attachment:write` permission and a versioned contract, allowed content type, positive bounded size, valid digest, durable audit event, and quarantined database record.

A scanner adapter verifies evidence before the engine accepts a result. The result must match the stored organization, attachment, quarantine key, and digest. Scanner errors remain quarantined. Clean results are atomically recorded before download is possible. Infected results are atomically recorded and the quarantined object is deleted. Invalid, replayed, cross-tenant, mismatched, or unverifiable results fail closed.

Downloads require `attachment:read` for the exact organization and a stored clean verdict. Quarantined and infected objects use the same non-disclosing rejection. Production adapters use short-lived HTTPS URLs, private buckets, encryption at rest, no public ACLs, least-privilege scanner credentials, and lifecycle cleanup for abandoned quarantine objects.
