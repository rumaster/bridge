-- up migration

CREATE TABLE broadcasts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  template jsonb NOT NULL DEFAULT '{}'::jsonb,
  filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  schedule jsonb NOT NULL DEFAULT '{}'::jsonb,
  rate_limit jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broadcasts_id_organization_id_unique UNIQUE (id, organization_id),
  CONSTRAINT broadcasts_created_by_organization_fk
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT broadcasts_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT broadcasts_status_check CHECK (
    status IN ('draft', 'scheduled', 'running', 'done', 'failed')
  ),
  CONSTRAINT broadcasts_template_is_object CHECK (jsonb_typeof(template) = 'object'),
  CONSTRAINT broadcasts_filter_is_object CHECK (jsonb_typeof(filter) = 'object'),
  CONSTRAINT broadcasts_schedule_is_object CHECK (jsonb_typeof(schedule) = 'object'),
  CONSTRAINT broadcasts_rate_limit_is_object CHECK (jsonb_typeof(rate_limit) = 'object'),
  CONSTRAINT broadcasts_updated_after_created_check CHECK (updated_at >= created_at)
);

COMMENT ON TABLE broadcasts IS
  'M4 Broadcast campaign metadata. Delivery is performed through messages and outbox_events.';

CREATE INDEX broadcasts_organization_id_idx ON broadcasts (organization_id);
CREATE INDEX broadcasts_status_idx ON broadcasts (organization_id, status);
CREATE INDEX broadcasts_created_by_idx ON broadcasts (created_by);

CREATE TABLE broadcast_recipients (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  broadcast_id uuid NOT NULL,
  client_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'prepared',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broadcast_recipients_id_organization_id_unique UNIQUE (id, organization_id),
  CONSTRAINT broadcast_recipients_broadcast_organization_fk
    FOREIGN KEY (broadcast_id, organization_id)
    REFERENCES broadcasts(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT broadcast_recipients_client_organization_fk
    FOREIGN KEY (client_id, organization_id)
    REFERENCES clients(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT broadcast_recipients_endpoint_organization_fk
    FOREIGN KEY (endpoint_id, organization_id)
    REFERENCES communication_endpoints(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT broadcast_recipients_status_check CHECK (
    status IN ('prepared', 'sent', 'delivered', 'failed', 'skipped')
  ),
  CONSTRAINT broadcast_recipients_updated_after_created_check CHECK (
    updated_at >= created_at
  ),
  CONSTRAINT broadcast_recipients_broadcast_endpoint_unique UNIQUE (
    organization_id,
    broadcast_id,
    endpoint_id
  )
);

CREATE INDEX broadcast_recipients_organization_id_idx
  ON broadcast_recipients (organization_id);
CREATE INDEX broadcast_recipients_broadcast_id_idx
  ON broadcast_recipients (broadcast_id);
CREATE INDEX broadcast_recipients_client_id_idx ON broadcast_recipients (client_id);
CREATE INDEX broadcast_recipients_endpoint_id_idx ON broadcast_recipients (endpoint_id);
CREATE INDEX broadcast_recipients_status_idx
  ON broadcast_recipients (organization_id, broadcast_id, status);

CREATE TABLE broadcast_messages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  broadcast_id uuid NOT NULL,
  message_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'prepared',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broadcast_messages_id_organization_id_unique UNIQUE (id, organization_id),
  CONSTRAINT broadcast_messages_broadcast_organization_fk
    FOREIGN KEY (broadcast_id, organization_id)
    REFERENCES broadcasts(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT broadcast_messages_message_organization_fk
    FOREIGN KEY (message_id, organization_id)
    REFERENCES messages(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT broadcast_messages_status_check CHECK (
    status IN ('prepared', 'sent', 'delivered', 'failed', 'skipped')
  ),
  CONSTRAINT broadcast_messages_updated_after_created_check CHECK (
    updated_at >= created_at
  ),
  CONSTRAINT broadcast_messages_broadcast_message_unique UNIQUE (
    organization_id,
    broadcast_id,
    message_id
  )
);

COMMENT ON TABLE broadcast_messages IS
  'M4 link from Broadcast campaign output to messages, preserving the single delivery mechanism.';

CREATE INDEX broadcast_messages_organization_id_idx
  ON broadcast_messages (organization_id);
CREATE INDEX broadcast_messages_broadcast_id_idx ON broadcast_messages (broadcast_id);
CREATE INDEX broadcast_messages_message_id_idx ON broadcast_messages (message_id);
CREATE INDEX broadcast_messages_status_idx
  ON broadcast_messages (organization_id, broadcast_id, status);

CREATE TABLE broadcast_stats (
  broadcast_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  prepared integer NOT NULL DEFAULT 0,
  sent integer NOT NULL DEFAULT 0,
  delivered integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broadcast_stats_broadcast_organization_fk
    FOREIGN KEY (broadcast_id, organization_id)
    REFERENCES broadcasts(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT broadcast_stats_prepared_non_negative CHECK (prepared >= 0),
  CONSTRAINT broadcast_stats_sent_non_negative CHECK (sent >= 0),
  CONSTRAINT broadcast_stats_delivered_non_negative CHECK (delivered >= 0),
  CONSTRAINT broadcast_stats_failed_non_negative CHECK (failed >= 0)
);

CREATE INDEX broadcast_stats_organization_id_idx ON broadcast_stats (organization_id);

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  recipient_user_id uuid NOT NULL,
  category text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT notifications_id_organization_id_unique UNIQUE (id, organization_id),
  CONSTRAINT notifications_recipient_organization_fk
    FOREIGN KEY (recipient_user_id, organization_id)
    REFERENCES users(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT notifications_category_check CHECK (
    category IN ('info', 'warning', 'error', 'critical', 'admin')
  ),
  CONSTRAINT notifications_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT notifications_body_not_blank CHECK (btrim(body) <> ''),
  CONSTRAINT notifications_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT notifications_status_check CHECK (status IN ('new', 'read')),
  CONSTRAINT notifications_read_at_consistency_check CHECK (
    (status = 'read' AND read_at IS NOT NULL)
    OR (status = 'new' AND read_at IS NULL)
  ),
  CONSTRAINT notifications_read_after_created_check CHECK (
    read_at IS NULL OR read_at >= created_at
  )
);

CREATE INDEX notifications_organization_id_idx ON notifications (organization_id);
CREATE INDEX notifications_recipient_user_id_idx ON notifications (recipient_user_id);
CREATE INDEX notifications_status_created_at_idx
  ON notifications (organization_id, recipient_user_id, status, created_at);

CREATE TABLE notification_settings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  category text NOT NULL,
  channel text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_settings_user_organization_fk
    FOREIGN KEY (user_id, organization_id)
    REFERENCES users(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT notification_settings_category_check CHECK (
    category IN ('info', 'warning', 'error', 'critical', 'admin')
  ),
  CONSTRAINT notification_settings_channel_check CHECK (
    channel IN ('web', 'telegram', 'email', 'push')
  ),
  CONSTRAINT notification_settings_updated_after_created_check CHECK (
    updated_at >= created_at
  ),
  CONSTRAINT notification_settings_user_category_channel_unique UNIQUE (
    organization_id,
    user_id,
    category,
    channel
  )
);

CREATE INDEX notification_settings_organization_id_idx
  ON notification_settings (organization_id);
CREATE INDEX notification_settings_user_id_idx ON notification_settings (user_id);

ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcasts FORCE ROW LEVEL SECURITY;
CREATE POLICY broadcasts_tenant_isolation ON broadcasts
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE broadcast_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY broadcast_recipients_tenant_isolation ON broadcast_recipients
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE broadcast_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY broadcast_messages_tenant_isolation ON broadcast_messages
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE broadcast_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_stats FORCE ROW LEVEL SECURITY;
CREATE POLICY broadcast_stats_tenant_isolation ON broadcast_stats
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_tenant_isolation ON notifications
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_settings_tenant_isolation ON notification_settings
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

-- down migration

DROP POLICY IF EXISTS notification_settings_tenant_isolation ON notification_settings;
ALTER TABLE IF EXISTS notification_settings DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS notification_settings;

DROP POLICY IF EXISTS notifications_tenant_isolation ON notifications;
ALTER TABLE IF EXISTS notifications DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS notifications;

DROP POLICY IF EXISTS broadcast_stats_tenant_isolation ON broadcast_stats;
ALTER TABLE IF EXISTS broadcast_stats DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS broadcast_stats;

DROP POLICY IF EXISTS broadcast_messages_tenant_isolation ON broadcast_messages;
ALTER TABLE IF EXISTS broadcast_messages DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS broadcast_messages;

DROP POLICY IF EXISTS broadcast_recipients_tenant_isolation ON broadcast_recipients;
ALTER TABLE IF EXISTS broadcast_recipients DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS broadcast_recipients;

DROP POLICY IF EXISTS broadcasts_tenant_isolation ON broadcasts;
ALTER TABLE IF EXISTS broadcasts DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS broadcasts;
