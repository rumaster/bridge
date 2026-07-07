-- up migration

CREATE TABLE web_chat_email_codes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  endpoint_id uuid NOT NULL,
  email text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT web_chat_email_codes_endpoint_organization_fk
    FOREIGN KEY (endpoint_id, organization_id)
    REFERENCES communication_endpoints(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT web_chat_email_codes_email_not_blank CHECK (btrim(email) <> ''),
  CONSTRAINT web_chat_email_codes_code_hash_not_blank CHECK (btrim(code_hash) <> ''),
  CONSTRAINT web_chat_email_codes_expires_after_created_check CHECK (expires_at > created_at),
  CONSTRAINT web_chat_email_codes_attempt_count_non_negative CHECK (attempt_count >= 0),
  CONSTRAINT web_chat_email_codes_consumed_after_created_check CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  ),
  CONSTRAINT web_chat_email_codes_locked_until_after_created_check CHECK (
    locked_until IS NULL OR locked_until >= created_at
  )
);

CREATE INDEX web_chat_email_codes_organization_id_idx
  ON web_chat_email_codes (organization_id);
CREATE INDEX web_chat_email_codes_endpoint_email_idx
  ON web_chat_email_codes (organization_id, endpoint_id, lower(email), created_at DESC);
CREATE INDEX web_chat_email_codes_expires_at_idx ON web_chat_email_codes (expires_at);

ALTER TABLE web_chat_email_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_chat_email_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY web_chat_email_codes_tenant_isolation ON web_chat_email_codes
  USING (
    organization_id = current_setting('app.current_organization_id', true)::uuid
    OR current_setting('app.is_platform_operator', true)::boolean
  )
  WITH CHECK (
    organization_id = current_setting('app.current_organization_id', true)::uuid
    OR current_setting('app.is_platform_operator', true)::boolean
  );

-- down migration

DROP POLICY IF EXISTS web_chat_email_codes_tenant_isolation ON web_chat_email_codes;
ALTER TABLE IF EXISTS web_chat_email_codes DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS web_chat_email_codes;
