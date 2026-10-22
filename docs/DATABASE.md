# PostgreSQL migrations and rollback

Ordered SQL pairs in `database/migrations` own the engine schema. Every `NNNN_name.up.sql` file requires a matching `NNNN_name.down.sql`; the dependency-free runner executes upgrades in ascending order and rollbacks in reverse order, with each file wrapped in a transaction and `ON_ERROR_STOP` enabled.

Set `DATABASE_URL` and run `npm run migrate:up` to apply the schema or `npm run migrate:down` to remove it. The initial migration records its ID, creates organization-scoped memberships and resources, and forces row-level security. Resource reads require matching organization context, an active membership, and explicit `resource:read` permission. Missing tenant context, inactive membership, missing permission, and cross-tenant identifiers all return no rows under the application role.

CI validates the SQL contract, applies it to PostgreSQL 16, exercises authorized and denied reads as a non-superuser, rolls it back, and verifies that the `marketplace` schema no longer exists. Migration files must never contain credentials or environment-specific identities.
