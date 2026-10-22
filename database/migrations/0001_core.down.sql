DROP POLICY IF EXISTS tenant_resource_read ON marketplace.resources;
DROP TABLE marketplace.resources;
DROP TABLE marketplace.memberships;
DROP TABLE marketplace.organizations;
DELETE FROM marketplace.schema_migrations WHERE id = '0001_core';
DROP TABLE marketplace.schema_migrations;
DROP SCHEMA marketplace;
