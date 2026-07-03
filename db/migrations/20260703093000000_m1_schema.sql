-- up migration

ALTER TABLE users
  ADD CONSTRAINT users_id_organization_id_unique UNIQUE (id, organization_id);

CREATE FUNCTION app.uuid_from_text(value text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT (
    substr(md5(value), 1, 8) || '-' ||
    substr(md5(value), 9, 4) || '-4' ||
    substr(md5(value), 14, 3) || '-8' ||
    substr(md5(value), 18, 3) || '-' ||
    substr(md5(value), 21, 12)
  )::uuid;
$$;

CREATE FUNCTION app.reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only and cannot be %', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = '55000';
END;
$$;

CREATE TABLE configurations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  key text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT configurations_updated_by_organization_fk
    FOREIGN KEY (updated_by, organization_id)
    REFERENCES users(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT configurations_key_not_blank CHECK (btrim(key) <> ''),
  CONSTRAINT configurations_value_is_object CHECK (jsonb_typeof(value) = 'object'),
  CONSTRAINT configurations_version_positive CHECK (version > 0),
  CONSTRAINT configurations_organization_key_unique UNIQUE (organization_id, key)
);

CREATE INDEX configurations_organization_id_idx ON configurations (organization_id);

CREATE TABLE configuration_history (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  config_key text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT configuration_history_changed_by_organization_fk
    FOREIGN KEY (changed_by, organization_id)
    REFERENCES users(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT configuration_history_config_key_not_blank CHECK (btrim(config_key) <> ''),
  CONSTRAINT configuration_history_value_is_object CHECK (jsonb_typeof(value) = 'object'),
  CONSTRAINT configuration_history_version_positive CHECK (version > 0),
  CONSTRAINT configuration_history_organization_key_version_unique UNIQUE (
    organization_id,
    config_key,
    version
  )
);

CREATE INDEX configuration_history_organization_id_idx
  ON configuration_history (organization_id);
CREATE INDEX configuration_history_organization_key_version_idx
  ON configuration_history (organization_id, config_key, version);

CREATE FUNCTION app.record_configuration_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO configuration_history (
    id,
    organization_id,
    config_key,
    value,
    version,
    changed_by,
    changed_at
  )
  VALUES (
    app.uuid_from_text(NEW.id::text || ':' || NEW.version::text),
    NEW.organization_id,
    NEW.key,
    NEW.value,
    NEW.version,
    NEW.updated_by,
    NEW.updated_at
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER configurations_record_history
AFTER INSERT OR UPDATE ON configurations
FOR EACH ROW
EXECUTE FUNCTION app.record_configuration_history();

CREATE TRIGGER configuration_history_append_only
BEFORE UPDATE OR DELETE ON configuration_history
FOR EACH ROW
EXECUTE FUNCTION app.reject_append_only_mutation();

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid,
  actor_type text NOT NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id uuid,
  result text NOT NULL,
  request_id text,
  ip inet,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_actor_user_organization_fk
    FOREIGN KEY (actor_user_id, organization_id)
    REFERENCES users(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT audit_events_actor_type_check CHECK (
    actor_type IN ('user', 'ai', 'workflow', 'system')
  ),
  CONSTRAINT audit_events_action_not_blank CHECK (btrim(action) <> ''),
  CONSTRAINT audit_events_object_type_not_blank CHECK (btrim(object_type) <> ''),
  CONSTRAINT audit_events_result_check CHECK (result IN ('success', 'failure', 'denied')),
  CONSTRAINT audit_events_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX audit_events_organization_id_idx ON audit_events (organization_id);
CREATE INDEX audit_events_created_at_idx ON audit_events (created_at);

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION app.reject_append_only_mutation();

CREATE TABLE user_roles (
  user_id uuid NOT NULL,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id, organization_id),
  CONSTRAINT user_roles_user_organization_fk
    FOREIGN KEY (user_id, organization_id)
    REFERENCES users(id, organization_id)
    ON DELETE CASCADE
);

CREATE INDEX user_roles_organization_id_idx ON user_roles (organization_id);
CREATE INDEX user_roles_role_id_idx ON user_roles (role_id);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip inet,
  user_agent text,
  CONSTRAINT auth_sessions_user_organization_fk
    FOREIGN KEY (user_id, organization_id)
    REFERENCES users(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT auth_sessions_expires_after_issued_check CHECK (expires_at > issued_at),
  CONSTRAINT auth_sessions_revoked_after_issued_check CHECK (
    revoked_at IS NULL OR revoked_at >= issued_at
  )
);

CREATE INDEX auth_sessions_organization_id_idx ON auth_sessions (organization_id);
CREATE INDEX auth_sessions_user_id_idx ON auth_sessions (user_id);

CREATE TABLE login_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code_hash text NOT NULL,
  purpose text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT login_codes_user_organization_fk
    FOREIGN KEY (user_id, organization_id)
    REFERENCES users(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT login_codes_code_hash_not_blank CHECK (btrim(code_hash) <> ''),
  CONSTRAINT login_codes_purpose_not_blank CHECK (btrim(purpose) <> ''),
  CONSTRAINT login_codes_expires_after_created_check CHECK (expires_at > created_at),
  CONSTRAINT login_codes_consumed_after_created_check CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  )
);

CREATE INDEX login_codes_organization_id_idx ON login_codes (organization_id);
CREATE INDEX login_codes_user_id_idx ON login_codes (user_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  contact_type text NOT NULL,
  contact_value text NOT NULL,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_created_by_organization_fk
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT invitations_contact_type_check CHECK (contact_type IN ('email', 'telegram')),
  CONSTRAINT invitations_contact_value_not_blank CHECK (btrim(contact_value) <> ''),
  CONSTRAINT invitations_token_hash_not_blank CHECK (btrim(token_hash) <> ''),
  CONSTRAINT invitations_expires_after_created_check CHECK (expires_at > created_at),
  CONSTRAINT invitations_accepted_after_created_check CHECK (
    accepted_at IS NULL OR accepted_at >= created_at
  ),
  CONSTRAINT invitations_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX invitations_organization_id_idx ON invitations (organization_id);
CREATE INDEX invitations_role_id_idx ON invitations (role_id);

CREATE TABLE clients (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  display_name text,
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clients_id_organization_id_unique UNIQUE (id, organization_id),
  CONSTRAINT clients_display_name_not_blank CHECK (
    display_name IS NULL OR btrim(display_name) <> ''
  ),
  CONSTRAINT clients_updated_after_created_check CHECK (updated_at >= created_at),
  CONSTRAINT clients_anonymized_after_created_check CHECK (
    anonymized_at IS NULL OR anonymized_at >= created_at
  )
);

CREATE INDEX clients_organization_id_idx ON clients (organization_id);

CREATE TABLE communication_endpoints (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL,
  channel text NOT NULL,
  external_id text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT communication_endpoints_id_organization_id_unique UNIQUE (id, organization_id),
  CONSTRAINT communication_endpoints_client_organization_fk
    FOREIGN KEY (client_id, organization_id)
    REFERENCES clients(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT communication_endpoints_channel_not_blank CHECK (btrim(channel) <> ''),
  CONSTRAINT communication_endpoints_external_id_not_blank CHECK (btrim(external_id) <> ''),
  CONSTRAINT communication_endpoints_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT communication_endpoints_verified_at_check CHECK (
    verified OR verified_at IS NULL
  ),
  CONSTRAINT communication_endpoints_organization_channel_external_id_unique UNIQUE (
    organization_id,
    channel,
    external_id
  )
);

CREATE INDEX communication_endpoints_organization_id_idx
  ON communication_endpoints (organization_id);
CREATE INDEX communication_endpoints_client_id_idx ON communication_endpoints (client_id);

CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open',
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_id_organization_id_unique UNIQUE (id, organization_id),
  CONSTRAINT conversations_client_organization_fk
    FOREIGN KEY (client_id, organization_id)
    REFERENCES clients(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT conversations_status_check CHECK (status IN ('open', 'closed', 'pending')),
  CONSTRAINT conversations_last_message_after_created_check CHECK (
    last_message_at IS NULL OR last_message_at >= created_at
  ),
  CONSTRAINT conversations_updated_after_created_check CHECK (updated_at >= created_at)
);

CREATE INDEX conversations_organization_id_idx ON conversations (organization_id);
CREATE INDEX conversations_organization_client_idx ON conversations (organization_id, client_id);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  conversation_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  channel text NOT NULL,
  direction text NOT NULL,
  sender_type text NOT NULL,
  sequence_number bigint NOT NULL,
  type text NOT NULL,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CONSTRAINT messages_id_organization_id_unique UNIQUE (id, organization_id),
  CONSTRAINT messages_conversation_organization_fk
    FOREIGN KEY (conversation_id, organization_id)
    REFERENCES conversations(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT messages_endpoint_organization_fk
    FOREIGN KEY (endpoint_id, organization_id)
    REFERENCES communication_endpoints(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT messages_channel_not_blank CHECK (btrim(channel) <> ''),
  CONSTRAINT messages_direction_check CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT messages_sender_type_check CHECK (
    sender_type IN ('client', 'manager', 'ai', 'broadcast', 'system')
  ),
  CONSTRAINT messages_sequence_number_positive CHECK (sequence_number > 0),
  CONSTRAINT messages_type_not_blank CHECK (btrim(type) <> ''),
  CONSTRAINT messages_content_is_object CHECK (jsonb_typeof(content) = 'object'),
  CONSTRAINT messages_status_check CHECK (
    status IN ('received', 'routed', 'sent', 'delivered', 'failed')
  ),
  CONSTRAINT messages_delivered_after_created_check CHECK (
    delivered_at IS NULL OR delivered_at >= created_at
  )
);

COMMENT ON COLUMN messages.id IS
  'Cross-service message_id and idempotency_key. The primary key rejects duplicates.';

CREATE INDEX messages_organization_id_idx ON messages (organization_id);
CREATE INDEX messages_conversation_id_idx ON messages (conversation_id);
CREATE INDEX messages_endpoint_sequence_number_idx ON messages (endpoint_id, sequence_number);

CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  message_id uuid NOT NULL,
  kind text NOT NULL,
  storage_ref text NOT NULL,
  mime text,
  size bigint NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachments_message_organization_fk
    FOREIGN KEY (message_id, organization_id)
    REFERENCES messages(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT attachments_kind_not_blank CHECK (btrim(kind) <> ''),
  CONSTRAINT attachments_storage_ref_not_blank CHECK (btrim(storage_ref) <> ''),
  CONSTRAINT attachments_size_non_negative CHECK (size >= 0),
  CONSTRAINT attachments_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX attachments_organization_id_idx ON attachments (organization_id);
CREATE INDEX attachments_message_id_idx ON attachments (message_id);

CREATE TABLE message_delivery_attempts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  message_id uuid NOT NULL,
  adapter text NOT NULL,
  attempt_no integer NOT NULL,
  status text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_delivery_attempts_message_organization_fk
    FOREIGN KEY (message_id, organization_id)
    REFERENCES messages(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT message_delivery_attempts_adapter_not_blank CHECK (btrim(adapter) <> ''),
  CONSTRAINT message_delivery_attempts_attempt_no_positive CHECK (attempt_no > 0),
  CONSTRAINT message_delivery_attempts_status_check CHECK (
    status IN ('pending', 'sent', 'delivered', 'failed')
  ),
  CONSTRAINT message_delivery_attempts_message_adapter_attempt_unique UNIQUE (
    message_id,
    adapter,
    attempt_no
  )
);

CREATE INDEX message_delivery_attempts_organization_id_idx
  ON message_delivery_attempts (organization_id);
CREATE INDEX message_delivery_attempts_message_id_idx
  ON message_delivery_attempts (message_id);

ALTER TABLE configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE configurations FORCE ROW LEVEL SECURITY;
CREATE POLICY configurations_tenant_isolation ON configurations
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE configuration_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuration_history FORCE ROW LEVEL SECURITY;
CREATE POLICY configuration_history_tenant_isolation ON configuration_history
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant_isolation ON audit_events
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY user_roles_tenant_isolation ON user_roles
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_sessions_tenant_isolation ON auth_sessions
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE login_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY login_codes_tenant_isolation ON login_codes
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitations_tenant_isolation ON invitations
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
CREATE POLICY clients_tenant_isolation ON clients
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE communication_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY communication_endpoints_tenant_isolation ON communication_endpoints
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY conversations_tenant_isolation ON conversations
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
CREATE POLICY messages_tenant_isolation ON messages
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY attachments_tenant_isolation ON attachments
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE message_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_delivery_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY message_delivery_attempts_tenant_isolation ON message_delivery_attempts
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

-- down migration

DROP POLICY IF EXISTS message_delivery_attempts_tenant_isolation ON message_delivery_attempts;
ALTER TABLE IF EXISTS message_delivery_attempts DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS message_delivery_attempts;

DROP POLICY IF EXISTS attachments_tenant_isolation ON attachments;
ALTER TABLE IF EXISTS attachments DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS attachments;

DROP POLICY IF EXISTS messages_tenant_isolation ON messages;
ALTER TABLE IF EXISTS messages DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS messages;

DROP POLICY IF EXISTS conversations_tenant_isolation ON conversations;
ALTER TABLE IF EXISTS conversations DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS conversations;

DROP POLICY IF EXISTS communication_endpoints_tenant_isolation ON communication_endpoints;
ALTER TABLE IF EXISTS communication_endpoints DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS communication_endpoints;

DROP POLICY IF EXISTS clients_tenant_isolation ON clients;
ALTER TABLE IF EXISTS clients DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS clients;

DROP POLICY IF EXISTS invitations_tenant_isolation ON invitations;
ALTER TABLE IF EXISTS invitations DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS invitations;

DROP POLICY IF EXISTS login_codes_tenant_isolation ON login_codes;
ALTER TABLE IF EXISTS login_codes DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS login_codes;

DROP POLICY IF EXISTS auth_sessions_tenant_isolation ON auth_sessions;
ALTER TABLE IF EXISTS auth_sessions DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS auth_sessions;

DROP POLICY IF EXISTS user_roles_tenant_isolation ON user_roles;
ALTER TABLE IF EXISTS user_roles DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS user_roles;

DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
DROP POLICY IF EXISTS audit_events_tenant_isolation ON audit_events;
ALTER TABLE IF EXISTS audit_events DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS audit_events;

DROP TRIGGER IF EXISTS configuration_history_append_only ON configuration_history;
DROP TRIGGER IF EXISTS configurations_record_history ON configurations;

DROP POLICY IF EXISTS configuration_history_tenant_isolation ON configuration_history;
ALTER TABLE IF EXISTS configuration_history DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS configuration_history;

DROP POLICY IF EXISTS configurations_tenant_isolation ON configurations;
ALTER TABLE IF EXISTS configurations DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS configurations;

DROP FUNCTION IF EXISTS app.record_configuration_history();
DROP FUNCTION IF EXISTS app.reject_append_only_mutation();
DROP FUNCTION IF EXISTS app.uuid_from_text(text);

ALTER TABLE IF EXISTS users
  DROP CONSTRAINT IF EXISTS users_id_organization_id_unique;
