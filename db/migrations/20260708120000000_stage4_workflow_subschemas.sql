-- up migration

CREATE TABLE workflow_subschemas (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  slug text NOT NULL,
  name text NOT NULL,
  schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_subschemas_id_organization_id_unique UNIQUE (id, organization_id),
  CONSTRAINT workflow_subschemas_slug_not_blank CHECK (btrim(slug) <> ''),
  CONSTRAINT workflow_subschemas_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,127}$'),
  CONSTRAINT workflow_subschemas_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT workflow_subschemas_schema_is_object CHECK (jsonb_typeof(schema) = 'object'),
  CONSTRAINT workflow_subschemas_status_check CHECK (status IN ('draft', 'active')),
  CONSTRAINT workflow_subschemas_updated_after_created_check CHECK (updated_at >= created_at),
  CONSTRAINT workflow_subschemas_organization_slug_unique UNIQUE (organization_id, slug)
);

CREATE INDEX workflow_subschemas_organization_id_idx ON workflow_subschemas (organization_id);
CREATE INDEX workflow_subschemas_active_idx
  ON workflow_subschemas (organization_id, slug)
  WHERE status = 'active';

ALTER TABLE workflow_subschemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_subschemas FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_subschemas_tenant_isolation ON workflow_subschemas
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

-- down migration

DROP POLICY IF EXISTS workflow_subschemas_tenant_isolation ON workflow_subschemas;
ALTER TABLE IF EXISTS workflow_subschemas DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS workflow_subschemas;
