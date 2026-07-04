-- up migration

DROP TRIGGER IF EXISTS configurations_record_history ON configurations;

CREATE OR REPLACE FUNCTION app.record_configuration_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  history_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    history_id := app.uuid_from_text(OLD.id::text || ':' || (OLD.version + 1)::text || ':deleted');

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
      history_id,
      OLD.organization_id,
      OLD.key,
      OLD.value || jsonb_build_object('deleted', true),
      OLD.version + 1,
      OLD.updated_by,
      clock_timestamp()
    );

    RETURN OLD;
  END IF;

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
AFTER INSERT OR UPDATE OR DELETE ON configurations
FOR EACH ROW
EXECUTE FUNCTION app.record_configuration_history();

CREATE INDEX clients_anonymized_at_idx
  ON clients (organization_id, anonymized_at)
  WHERE anonymized_at IS NOT NULL;

CREATE INDEX communication_endpoints_client_channel_idx
  ON communication_endpoints (organization_id, client_id, channel);

CREATE INDEX audit_events_object_lookup_idx
  ON audit_events (organization_id, object_type, object_id, created_at);

ALTER TABLE login_codes
  DROP CONSTRAINT IF EXISTS login_codes_purpose_check,
  ADD CONSTRAINT login_codes_purpose_check
    CHECK (purpose IN ('telegram_login', 'email_login'));

COMMENT ON CONSTRAINT login_codes_purpose_check ON login_codes IS
  'M5 pluggable auth provider extension point. email_login is reserved for the disabled MVP email provider.';

CREATE FUNCTION app.anonymize_client_personal_data(
  p_organization_id uuid,
  p_client_id uuid,
  p_actor_user_id uuid DEFAULT NULL,
  p_request_id text DEFAULT NULL,
  p_reason_code text DEFAULT 'subject_erasure_request'
)
RETURNS TABLE (
  client_id uuid,
  anonymized_at timestamptz,
  endpoints integer,
  identity_links integer,
  messages integer,
  attachments integer,
  delivery_attempts integer,
  notes integer,
  tags integer,
  audit_event_id uuid
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_audit_event_id uuid;
  v_endpoints integer := 0;
  v_identity_links integer := 0;
  v_messages integer := 0;
  v_attachments integer := 0;
  v_delivery_attempts integer := 0;
  v_notes integer := 0;
  v_tags integer := 0;
BEGIN
  IF p_reason_code IS NULL OR p_reason_code !~ '^[a-z0-9][a-z0-9_.:-]{0,63}$' THEN
    RAISE EXCEPTION 'reason_code must be a stable non-PII code'
      USING ERRCODE = '22023';
  END IF;

  IF p_request_id IS NOT NULL AND p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' THEN
    RAISE EXCEPTION 'request_id must be a stable non-PII identifier'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM clients c
  WHERE c.organization_id = p_organization_id
    AND c.id = p_client_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'client % not found in organization %', p_client_id, p_organization_id
      USING ERRCODE = 'P0002';
  END IF;

  v_audit_event_id := app.uuid_from_text(
    'client.anonymized:' ||
    p_organization_id::text ||
    ':' ||
    p_client_id::text ||
    ':' ||
    txid_current()::text ||
    ':' ||
    v_now::text
  );

  UPDATE communication_endpoints ce
  SET external_id = 'anonymous:' || app.uuid_from_text('communication_endpoints:' || ce.id::text)::text,
      verified = false,
      verified_at = NULL,
      metadata = '{"anonymized":true}'::jsonb
  WHERE ce.organization_id = p_organization_id
    AND ce.client_id = p_client_id;
  GET DIAGNOSTICS v_endpoints = ROW_COUNT;

  UPDATE messages msg
  SET content = '{"anonymized":true}'::jsonb
  WHERE msg.organization_id = p_organization_id
    AND (
      msg.conversation_id IN (
        SELECT c.id
        FROM conversations c
        WHERE c.organization_id = p_organization_id
          AND c.client_id = p_client_id
      )
      OR msg.endpoint_id IN (
        SELECT ce.id
        FROM communication_endpoints ce
        WHERE ce.organization_id = p_organization_id
          AND ce.client_id = p_client_id
      )
    );
  GET DIAGNOSTICS v_messages = ROW_COUNT;

  UPDATE attachments a
  SET storage_ref = 'anonymized://attachment/' || a.id::text,
      metadata = '{"anonymized":true}'::jsonb
  WHERE a.organization_id = p_organization_id
    AND a.message_id IN (
      SELECT m.id
      FROM messages m
      JOIN conversations c
        ON c.id = m.conversation_id
       AND c.organization_id = m.organization_id
      WHERE m.organization_id = p_organization_id
        AND c.client_id = p_client_id
      UNION
      SELECT m.id
      FROM messages m
      JOIN communication_endpoints e
        ON e.id = m.endpoint_id
       AND e.organization_id = m.organization_id
      WHERE m.organization_id = p_organization_id
        AND e.client_id = p_client_id
    );
  GET DIAGNOSTICS v_attachments = ROW_COUNT;

  UPDATE message_delivery_attempts mda
  SET error = NULL
  WHERE mda.organization_id = p_organization_id
    AND mda.message_id IN (
      SELECT m.id
      FROM messages m
      JOIN conversations c
        ON c.id = m.conversation_id
       AND c.organization_id = m.organization_id
      WHERE m.organization_id = p_organization_id
        AND c.client_id = p_client_id
      UNION
      SELECT m.id
      FROM messages m
      JOIN communication_endpoints e
        ON e.id = m.endpoint_id
       AND e.organization_id = m.organization_id
      WHERE m.organization_id = p_organization_id
        AND e.client_id = p_client_id
    );
  GET DIAGNOSTICS v_delivery_attempts = ROW_COUNT;

  UPDATE client_identity_links cil
  SET evidence = '{"anonymized":true}'::jsonb,
      reverted_reason = CASE
        WHEN cil.reverted_reason IS NULL THEN NULL
        ELSE 'anonymized'
      END
  WHERE cil.organization_id = p_organization_id
    AND cil.client_id = p_client_id;
  GET DIAGNOSTICS v_identity_links = ROW_COUNT;

  UPDATE client_notes cn
  SET body = '[anonymized]'
  WHERE cn.organization_id = p_organization_id
    AND cn.client_id = p_client_id;
  GET DIAGNOSTICS v_notes = ROW_COUNT;

  UPDATE client_tags ct
  SET tag = 'anonymized:' || app.uuid_from_text('client_tags:' || ct.id::text)::text
  WHERE ct.organization_id = p_organization_id
    AND ct.client_id = p_client_id;
  GET DIAGNOSTICS v_tags = ROW_COUNT;

  UPDATE clients c
  SET display_name = NULL,
      anonymized_at = v_now,
      updated_at = v_now
  WHERE c.organization_id = p_organization_id
    AND c.id = p_client_id;

  INSERT INTO audit_events (
    id,
    organization_id,
    actor_user_id,
    actor_type,
    action,
    object_type,
    object_id,
    result,
    request_id,
    metadata,
    created_at
  )
  VALUES (
    v_audit_event_id,
    p_organization_id,
    p_actor_user_id,
    CASE WHEN p_actor_user_id IS NULL THEN 'system' ELSE 'user' END,
    'client.anonymized',
    'client',
    p_client_id,
    'success',
    p_request_id,
    jsonb_build_object(
      'client_id', p_client_id::text,
      'reason_code', p_reason_code,
      'endpoints', v_endpoints,
      'identity_links', v_identity_links,
      'messages', v_messages,
      'attachments', v_attachments,
      'delivery_attempts', v_delivery_attempts,
      'notes', v_notes,
      'tags', v_tags
    ),
    v_now
  );

  RETURN QUERY SELECT
    p_client_id,
    v_now,
    v_endpoints,
    v_identity_links,
    v_messages,
    v_attachments,
    v_delivery_attempts,
    v_notes,
    v_tags,
    v_audit_event_id;
END;
$$;

COMMENT ON FUNCTION app.anonymize_client_personal_data(uuid, uuid, uuid, text, text) IS
  'M5 irreversible client personal-data anonymization. Preserves surrogate links and append-only audit.';

-- down migration

DROP FUNCTION IF EXISTS app.anonymize_client_personal_data(uuid, uuid, uuid, text, text);

ALTER TABLE IF EXISTS login_codes
  DROP CONSTRAINT IF EXISTS login_codes_purpose_check;

DROP INDEX IF EXISTS audit_events_object_lookup_idx;
DROP INDEX IF EXISTS communication_endpoints_client_channel_idx;
DROP INDEX IF EXISTS clients_anonymized_at_idx;

DROP TRIGGER IF EXISTS configurations_record_history ON configurations;

CREATE OR REPLACE FUNCTION app.record_configuration_history()
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
