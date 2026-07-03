-- up migration

CREATE TABLE workflows (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  default_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflows_id_organization_id_unique UNIQUE (id, organization_id),
  CONSTRAINT workflows_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT workflows_status_check CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT workflows_updated_after_created_check CHECK (updated_at >= created_at),
  CONSTRAINT workflows_organization_name_unique UNIQUE (organization_id, name)
);

CREATE INDEX workflows_organization_id_idx ON workflows (organization_id);

-- Неизменяемые версии Workflow (ТЗ §13.10): содержимое версии не меняется после
-- создания, `version_no` уникален и монотонен в рамках workflow.
CREATE TABLE workflow_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workflow_id uuid NOT NULL,
  version_no integer NOT NULL,
  schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_versions_id_organization_id_unique UNIQUE (id, organization_id),
  CONSTRAINT workflow_versions_workflow_organization_fk
    FOREIGN KEY (workflow_id, organization_id)
    REFERENCES workflows(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_versions_created_by_organization_fk
    FOREIGN KEY (created_by, organization_id)
    REFERENCES users(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_versions_version_no_positive CHECK (version_no > 0),
  CONSTRAINT workflow_versions_schema_is_object CHECK (jsonb_typeof(schema) = 'object'),
  CONSTRAINT workflow_versions_workflow_version_no_unique UNIQUE (workflow_id, version_no)
);

CREATE INDEX workflow_versions_organization_id_idx ON workflow_versions (organization_id);
CREATE INDEX workflow_versions_workflow_id_idx ON workflow_versions (workflow_id);

-- Неизменяемость версии: повторная запись/правка отклоняется на уровне БД.
CREATE TRIGGER workflow_versions_immutable
BEFORE UPDATE OR DELETE ON workflow_versions
FOR EACH ROW
EXECUTE FUNCTION app.reject_append_only_mutation();

ALTER TABLE workflows
  ADD CONSTRAINT workflows_default_version_organization_fk
    FOREIGN KEY (default_version_id, organization_id)
    REFERENCES workflow_versions(id, organization_id)
    ON DELETE RESTRICT;

-- Version pinning (ТЗ §13.10): экземпляр закреплён за конкретной версией.
CREATE TABLE workflow_instances (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workflow_id uuid NOT NULL,
  version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_instances_id_organization_id_unique UNIQUE (id, organization_id),
  CONSTRAINT workflow_instances_workflow_organization_fk
    FOREIGN KEY (workflow_id, organization_id)
    REFERENCES workflows(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_instances_version_organization_fk
    FOREIGN KEY (version_id, organization_id)
    REFERENCES workflow_versions(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_instances_status_check CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT workflow_instances_finished_after_started_check CHECK (
    finished_at IS NULL OR (started_at IS NOT NULL AND finished_at >= started_at)
  ),
  CONSTRAINT workflow_instances_started_after_created_check CHECK (
    started_at IS NULL OR started_at >= created_at
  )
);

CREATE INDEX workflow_instances_organization_id_idx ON workflow_instances (organization_id);
CREATE INDEX workflow_instances_workflow_id_idx ON workflow_instances (workflow_id);
CREATE INDEX workflow_instances_version_id_idx ON workflow_instances (version_id);

-- Состояние вне исполнителя (stateless executor, ТЗ §25.3).
CREATE TABLE workflow_instance_state (
  instance_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_instance_state_instance_organization_fk
    FOREIGN KEY (instance_id, organization_id)
    REFERENCES workflow_instances(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT workflow_instance_state_state_is_object CHECK (jsonb_typeof(state) = 'object')
);

CREATE INDEX workflow_instance_state_organization_id_idx
  ON workflow_instance_state (organization_id);

-- Журнал исполнения (ТЗ §13.9, §24.6): append-only, изолирован по арендатору.
CREATE TABLE workflow_execution_logs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  instance_id uuid NOT NULL,
  node_id text,
  event text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_execution_logs_instance_organization_fk
    FOREIGN KEY (instance_id, organization_id)
    REFERENCES workflow_instances(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_execution_logs_node_id_not_blank CHECK (
    node_id IS NULL OR btrim(node_id) <> ''
  ),
  CONSTRAINT workflow_execution_logs_event_not_blank CHECK (btrim(event) <> ''),
  CONSTRAINT workflow_execution_logs_data_is_object CHECK (jsonb_typeof(data) = 'object')
);

CREATE INDEX workflow_execution_logs_organization_id_idx
  ON workflow_execution_logs (organization_id);
CREATE INDEX workflow_execution_logs_instance_id_idx
  ON workflow_execution_logs (instance_id);
CREATE INDEX workflow_execution_logs_created_at_idx
  ON workflow_execution_logs (created_at);

CREATE TRIGGER workflow_execution_logs_append_only
BEFORE UPDATE OR DELETE ON workflow_execution_logs
FOR EACH ROW
EXECUTE FUNCTION app.reject_append_only_mutation();

-- Транзакционный outbox (C-OUT, мастер §4.10): доменные события ядра пишутся в
-- одной транзакции с изменением агрегата; доставка идёт выборкой pending-записей.
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT outbox_events_aggregate_type_not_blank CHECK (btrim(aggregate_type) <> ''),
  CONSTRAINT outbox_events_event_type_not_blank CHECK (btrim(event_type) <> ''),
  CONSTRAINT outbox_events_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_events_status_check CHECK (status IN ('pending', 'published', 'failed')),
  CONSTRAINT outbox_events_published_at_consistency_check CHECK (
    (status = 'published' AND published_at IS NOT NULL)
    OR (status <> 'published' AND published_at IS NULL)
  ),
  CONSTRAINT outbox_events_published_after_created_check CHECK (
    published_at IS NULL OR published_at >= created_at
  )
);

CREATE INDEX outbox_events_organization_id_idx ON outbox_events (organization_id);
CREATE INDEX outbox_events_status_idx ON outbox_events (status);
CREATE INDEX outbox_events_aggregate_idx ON outbox_events (aggregate_type, aggregate_id);
-- Выборка pending для доставки в порядке появления.
CREATE INDEX outbox_events_pending_idx
  ON outbox_events (created_at)
  WHERE status = 'pending';

ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows FORCE ROW LEVEL SECURITY;
CREATE POLICY workflows_tenant_isolation ON workflows
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE workflow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_versions_tenant_isolation ON workflow_versions
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE workflow_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_instances_tenant_isolation ON workflow_instances
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE workflow_instance_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_instance_state FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_instance_state_tenant_isolation ON workflow_instance_state
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE workflow_execution_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_execution_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_execution_logs_tenant_isolation ON workflow_execution_logs
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_events_tenant_isolation ON outbox_events
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

-- down migration

DROP POLICY IF EXISTS outbox_events_tenant_isolation ON outbox_events;
ALTER TABLE IF EXISTS outbox_events DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS outbox_events;

DROP TRIGGER IF EXISTS workflow_execution_logs_append_only ON workflow_execution_logs;
DROP POLICY IF EXISTS workflow_execution_logs_tenant_isolation ON workflow_execution_logs;
ALTER TABLE IF EXISTS workflow_execution_logs DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS workflow_execution_logs;

DROP POLICY IF EXISTS workflow_instance_state_tenant_isolation ON workflow_instance_state;
ALTER TABLE IF EXISTS workflow_instance_state DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS workflow_instance_state;

DROP POLICY IF EXISTS workflow_instances_tenant_isolation ON workflow_instances;
ALTER TABLE IF EXISTS workflow_instances DISABLE ROW LEVEL SECURITY;

ALTER TABLE IF EXISTS workflows DROP CONSTRAINT IF EXISTS workflows_default_version_organization_fk;

DROP TABLE IF EXISTS workflow_instances;

DROP TRIGGER IF EXISTS workflow_versions_immutable ON workflow_versions;
DROP POLICY IF EXISTS workflow_versions_tenant_isolation ON workflow_versions;
ALTER TABLE IF EXISTS workflow_versions DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS workflow_versions;

DROP POLICY IF EXISTS workflows_tenant_isolation ON workflows;
ALTER TABLE IF EXISTS workflows DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS workflows;
