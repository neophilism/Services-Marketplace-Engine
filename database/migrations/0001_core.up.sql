CREATE SCHEMA IF NOT EXISTS marketplace;

CREATE TABLE marketplace.schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE marketplace.organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200)
);

CREATE TABLE marketplace.memberships (
  organization_id uuid NOT NULL REFERENCES marketplace.organizations(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'inactive', 'revoked')),
  permissions text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (organization_id, subject_id)
);

CREATE TABLE marketplace.resources (
  organization_id uuid NOT NULL REFERENCES marketplace.organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (organization_id, id)
);

CREATE INDEX memberships_subject_lookup
  ON marketplace.memberships (subject_id, organization_id, status);

ALTER TABLE marketplace.resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace.resources FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_resource_read ON marketplace.resources
  FOR SELECT
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    AND EXISTS (
      SELECT 1
      FROM marketplace.memberships AS membership
      WHERE membership.organization_id = resources.organization_id
        AND membership.subject_id = nullif(current_setting('app.subject_id', true), '')::uuid
        AND membership.status = 'active'
        AND 'resource:read' = ANY (membership.permissions)
    )
  );

INSERT INTO marketplace.schema_migrations (id) VALUES ('0001_core');
