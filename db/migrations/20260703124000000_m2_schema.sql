-- up migration

CREATE TABLE knowledge_documents (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  title text NOT NULL,
  source text,
  status text NOT NULL DEFAULT 'indexing',
  indexed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_documents_id_organization_id_unique UNIQUE (id, organization_id),
  CONSTRAINT knowledge_documents_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT knowledge_documents_source_not_blank CHECK (
    source IS NULL OR btrim(source) <> ''
  ),
  CONSTRAINT knowledge_documents_status_check CHECK (
    status IN ('indexing', 'indexed', 'failed')
  ),
  CONSTRAINT knowledge_documents_indexed_status_check CHECK (
    status <> 'indexed' OR indexed_at IS NOT NULL
  ),
  CONSTRAINT knowledge_documents_indexed_after_created_check CHECK (
    indexed_at IS NULL OR indexed_at >= created_at
  ),
  CONSTRAINT knowledge_documents_updated_after_created_check CHECK (updated_at >= created_at)
);

CREATE INDEX knowledge_documents_organization_id_idx
  ON knowledge_documents (organization_id);

CREATE TABLE knowledge_chunks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  document_id uuid NOT NULL,
  chunk_no integer NOT NULL,
  content text NOT NULL,
  embedding vector(1536) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_chunks_document_organization_fk
    FOREIGN KEY (document_id, organization_id)
    REFERENCES knowledge_documents(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT knowledge_chunks_chunk_no_positive CHECK (chunk_no > 0),
  CONSTRAINT knowledge_chunks_content_not_blank CHECK (btrim(content) <> ''),
  CONSTRAINT knowledge_chunks_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT knowledge_chunks_document_chunk_unique UNIQUE (
    organization_id,
    document_id,
    chunk_no
  )
);

CREATE INDEX knowledge_chunks_organization_id_idx ON knowledge_chunks (organization_id);
CREATE INDEX knowledge_chunks_document_id_idx ON knowledge_chunks (document_id);
CREATE INDEX knowledge_chunks_embedding_hnsw_idx
  ON knowledge_chunks USING hnsw (embedding vector_l2_ops);

CREATE TABLE client_identity_links (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  link_type text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_by_actor_type text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  reverted_at timestamptz,
  reverted_by uuid,
  reverted_by_actor_type text,
  reverted_reason text,
  CONSTRAINT client_identity_links_client_organization_fk
    FOREIGN KEY (client_id, organization_id)
    REFERENCES clients(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT client_identity_links_endpoint_organization_fk
    FOREIGN KEY (endpoint_id, organization_id)
    REFERENCES communication_endpoints(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT client_identity_links_created_by_organization_fk
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT client_identity_links_reverted_by_organization_fk
    FOREIGN KEY (reverted_by, organization_id)
    REFERENCES users(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT client_identity_links_link_type_check CHECK (
    link_type IN ('verified_phone', 'verified_email', 'link_code', 'manual', 'automatic')
  ),
  CONSTRAINT client_identity_links_evidence_is_object CHECK (
    jsonb_typeof(evidence) = 'object'
  ),
  CONSTRAINT client_identity_links_created_by_actor_type_check CHECK (
    created_by_actor_type IN ('user', 'ai', 'workflow', 'system')
  ),
  CONSTRAINT client_identity_links_reverted_by_actor_type_check CHECK (
    reverted_by_actor_type IS NULL OR reverted_by_actor_type IN (
      'user',
      'ai',
      'workflow',
      'system'
    )
  ),
  CONSTRAINT client_identity_links_reverted_after_created_check CHECK (
    reverted_at IS NULL OR reverted_at >= created_at
  ),
  CONSTRAINT client_identity_links_revert_audit_check CHECK (
    (
      reverted_at IS NULL
      AND reverted_by IS NULL
      AND reverted_by_actor_type IS NULL
      AND reverted_reason IS NULL
    )
    OR (
      reverted_at IS NOT NULL
      AND reverted_by_actor_type IS NOT NULL
    )
  ),
  CONSTRAINT client_identity_links_reverted_reason_not_blank CHECK (
    reverted_reason IS NULL OR btrim(reverted_reason) <> ''
  )
);

CREATE INDEX client_identity_links_organization_id_idx
  ON client_identity_links (organization_id);
CREATE INDEX client_identity_links_client_id_idx ON client_identity_links (client_id);
CREATE INDEX client_identity_links_endpoint_id_idx ON client_identity_links (endpoint_id);
CREATE UNIQUE INDEX client_identity_links_active_endpoint_unique
  ON client_identity_links (organization_id, endpoint_id)
  WHERE reverted_at IS NULL;

CREATE UNIQUE INDEX messages_endpoint_sequence_number_unique
  ON messages (organization_id, endpoint_id, sequence_number);

CREATE TABLE channels (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  channel_type text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'disabled',
  credentials_ref text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_check_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channels_id_organization_id_unique UNIQUE (id, organization_id),
  CONSTRAINT channels_channel_type_not_blank CHECK (btrim(channel_type) <> ''),
  CONSTRAINT channels_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT channels_status_check CHECK (status IN ('connected', 'error', 'disabled')),
  CONSTRAINT channels_credentials_ref_not_blank CHECK (
    credentials_ref IS NULL OR btrim(credentials_ref) <> ''
  ),
  CONSTRAINT channels_config_is_object CHECK (jsonb_typeof(config) = 'object'),
  CONSTRAINT channels_config_no_inline_secrets CHECK (
    NOT (
      config ?| ARRAY[
        'api_key',
        'access_key',
        'client_secret',
        'password',
        'refresh_token',
        'secret',
        'token',
        'access_token'
      ]
    )
  ),
  CONSTRAINT channels_last_check_after_created_check CHECK (
    last_check_at IS NULL OR last_check_at >= created_at
  ),
  CONSTRAINT channels_updated_after_created_check CHECK (updated_at >= created_at),
  CONSTRAINT channels_organization_type_name_unique UNIQUE (
    organization_id,
    channel_type,
    name
  )
);

CREATE INDEX channels_organization_id_idx ON channels (organization_id);

CREATE TABLE adapter_capabilities (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  channel_id uuid NOT NULL,
  capability text NOT NULL,
  supported boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adapter_capabilities_channel_organization_fk
    FOREIGN KEY (channel_id, organization_id)
    REFERENCES channels(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT adapter_capabilities_capability_not_blank CHECK (btrim(capability) <> ''),
  CONSTRAINT adapter_capabilities_metadata_is_object CHECK (
    jsonb_typeof(metadata) = 'object'
  ),
  CONSTRAINT adapter_capabilities_updated_after_created_check CHECK (
    updated_at >= created_at
  ),
  CONSTRAINT adapter_capabilities_channel_capability_unique UNIQUE (
    organization_id,
    channel_id,
    capability
  )
);

CREATE INDEX adapter_capabilities_organization_id_idx
  ON adapter_capabilities (organization_id);
CREATE INDEX adapter_capabilities_channel_id_idx ON adapter_capabilities (channel_id);

ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_documents_tenant_isolation ON knowledge_documents
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_chunks_tenant_isolation ON knowledge_chunks
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE client_identity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_identity_links FORCE ROW LEVEL SECURITY;
CREATE POLICY client_identity_links_tenant_isolation ON client_identity_links
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels FORCE ROW LEVEL SECURITY;
CREATE POLICY channels_tenant_isolation ON channels
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE adapter_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE adapter_capabilities FORCE ROW LEVEL SECURITY;
CREATE POLICY adapter_capabilities_tenant_isolation ON adapter_capabilities
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

-- down migration

DROP POLICY IF EXISTS adapter_capabilities_tenant_isolation ON adapter_capabilities;
ALTER TABLE IF EXISTS adapter_capabilities DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS adapter_capabilities;

DROP POLICY IF EXISTS channels_tenant_isolation ON channels;
ALTER TABLE IF EXISTS channels DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS channels;

DROP POLICY IF EXISTS client_identity_links_tenant_isolation ON client_identity_links;
ALTER TABLE IF EXISTS client_identity_links DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS client_identity_links;

DROP INDEX IF EXISTS messages_endpoint_sequence_number_unique;

DROP POLICY IF EXISTS knowledge_chunks_tenant_isolation ON knowledge_chunks;
ALTER TABLE IF EXISTS knowledge_chunks DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS knowledge_chunks;

DROP POLICY IF EXISTS knowledge_documents_tenant_isolation ON knowledge_documents;
ALTER TABLE IF EXISTS knowledge_documents DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS knowledge_documents;
