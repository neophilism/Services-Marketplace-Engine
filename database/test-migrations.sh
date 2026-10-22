#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

psql "$DATABASE_URL" --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL'
DO $block$
BEGIN
  CREATE ROLE marketplace_app NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$block$;

GRANT USAGE ON SCHEMA marketplace TO marketplace_app;
GRANT SELECT ON marketplace.memberships, marketplace.resources TO marketplace_app;

INSERT INTO marketplace.organizations (id, name) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Organization One'),
  ('10000000-0000-4000-8000-000000000002', 'Organization Two');
INSERT INTO marketplace.memberships (organization_id, subject_id, status, permissions) VALUES
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'active', ARRAY['resource:read']),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'inactive', ARRAY['resource:read']),
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000003', 'active', ARRAY[]::text[]);
INSERT INTO marketplace.resources (organization_id, id, payload) VALUES
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '{"visible":true}');
SQL

visible_count() {
  local organization_id="$1"
  local subject_id="$2"
  psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --set organization_id="$organization_id" --set subject_id="$subject_id" <<'SQL'
SET ROLE marketplace_app;
SELECT set_config('app.organization_id', :'organization_id', false);
SELECT set_config('app.subject_id', :'subject_id', false);
SELECT count(*) FROM marketplace.resources
WHERE id = '30000000-0000-4000-8000-000000000001';
SQL
}

last_line() {
  tail -n 1 | tr -d '[:space:]'
}

test "$(visible_count '10000000-0000-4000-8000-000000000001' '20000000-0000-4000-8000-000000000001' | last_line)" = "1"
test "$(visible_count '' '20000000-0000-4000-8000-000000000001' | last_line)" = "0"
test "$(visible_count '10000000-0000-4000-8000-000000000001' '20000000-0000-4000-8000-000000000002' | last_line)" = "0"
test "$(visible_count '10000000-0000-4000-8000-000000000001' '20000000-0000-4000-8000-000000000003' | last_line)" = "0"
test "$(visible_count '10000000-0000-4000-8000-000000000002' '20000000-0000-4000-8000-000000000001' | last_line)" = "0"

test "$(psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT count(*) FROM marketplace.schema_migrations WHERE id = '0001_core'")" = "1"
