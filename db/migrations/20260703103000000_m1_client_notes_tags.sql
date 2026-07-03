-- up migration

CREATE TABLE client_notes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL,
  author_user_id uuid,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_notes_client_organization_fk
    FOREIGN KEY (client_id, organization_id)
    REFERENCES clients(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT client_notes_author_organization_fk
    FOREIGN KEY (author_user_id, organization_id)
    REFERENCES users(id, organization_id)
    ON DELETE SET NULL,
  CONSTRAINT client_notes_body_not_blank CHECK (btrim(body) <> '')
);

CREATE INDEX client_notes_organization_id_idx ON client_notes (organization_id);
CREATE INDEX client_notes_client_id_idx ON client_notes (client_id);

CREATE TABLE client_tags (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL,
  tag text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_tags_client_organization_fk
    FOREIGN KEY (client_id, organization_id)
    REFERENCES clients(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT client_tags_created_by_organization_fk
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users(id, organization_id)
    ON DELETE SET NULL,
  CONSTRAINT client_tags_tag_not_blank CHECK (btrim(tag) <> ''),
  CONSTRAINT client_tags_organization_client_tag_unique UNIQUE (organization_id, client_id, tag)
);

CREATE INDEX client_tags_organization_id_idx ON client_tags (organization_id);
CREATE INDEX client_tags_client_id_idx ON client_tags (client_id);

ALTER TABLE client_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY client_notes_tenant_isolation ON client_notes
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE client_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY client_tags_tenant_isolation ON client_tags
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

-- down migration

DROP POLICY IF EXISTS client_tags_tenant_isolation ON client_tags;
ALTER TABLE IF EXISTS client_tags DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS client_tags;

DROP POLICY IF EXISTS client_notes_tenant_isolation ON client_notes;
ALTER TABLE IF EXISTS client_notes DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS client_notes;
