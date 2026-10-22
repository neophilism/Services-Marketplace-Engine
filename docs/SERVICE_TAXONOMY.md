# Service taxonomy and intake schemas

SME-014 defines tenant-bound, industry-neutral service definitions and dynamic request-intake validation. Taxonomy administration requires `service-taxonomy:write`; published discovery requires `service-taxonomy:read`; validating a prospective submission requires `service-intake:submit`. Every decision is durably audited through the organization authorization boundary.

Each service revision is created as a draft, then explicitly published and optionally retired. Revision numbers are monotonic: revision 2 and later require the immediately preceding revision to have left draft state. Published parents are required before a child definition can be created or transitioned. Store adapters must enforce uniqueness for organization, service key, and revision and atomically compare the current record on transitions.

Intake schemas use a deliberately bounded vocabulary: text, integer, decimal, boolean, date, and enumerated choice fields. Field keys and labels, schema size, choice lists, and numeric or length bounds are limited. Submissions pin an exact published revision, reject unknown answer keys, require all mandatory fields, and validate every value without executing schema-provided code. Retirement prevents new validation while preserving the immutable revision for historical records.

Cross-tenant or mismatched adapter results, missing or excessive answers, stale versions, invalid transitions, unavailable audit storage, and persistence failures all return the same non-disclosing `service_taxonomy_rejected` result.
