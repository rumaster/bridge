-- up migration

-- Workflow 2.0 (docs/plan/workflow-2.0-redesign.md).
--
-- Подписки узлов «Ожидание события». Узел перестал быть паузой посреди схемы и
-- стал точкой входа: событие не будит спящий экземпляр, а запускает новый — с
-- того узла, чья подписка совпала. Подписки синхронизируются при копировании
-- драфта в рабочую версию: у драфта подписок нет.
CREATE TABLE workflow_event_subscriptions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workflow_id uuid NOT NULL,
  version_id uuid NOT NULL,
  node_id text NOT NULL,
  event_type text NOT NULL,
  -- Сужение подписки до сущности: { conversation_id: "..." } и т. п. Пустой
  -- объект означает «любое событие этого типа в организации».
  correlation jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_event_subscriptions_id_organization_id_unique UNIQUE (id, organization_id),
  CONSTRAINT workflow_event_subscriptions_workflow_fk
    FOREIGN KEY (workflow_id, organization_id) REFERENCES workflows (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT workflow_event_subscriptions_version_fk
    FOREIGN KEY (version_id, organization_id) REFERENCES workflow_versions (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT workflow_event_subscriptions_node_id_not_blank CHECK (btrim(node_id) <> ''),
  CONSTRAINT workflow_event_subscriptions_event_type_not_blank CHECK (btrim(event_type) <> ''),
  CONSTRAINT workflow_event_subscriptions_correlation_is_object CHECK (jsonb_typeof(correlation) = 'object'),
  -- Один узел одной версии подписывается ровно один раз: повтор означал бы
  -- двойной запуск экземпляра на одно событие.
  CONSTRAINT workflow_event_subscriptions_node_unique UNIQUE (organization_id, version_id, node_id)
);

-- Горячий путь диспетчера: «какие подписки ждут событие такого типа».
CREATE INDEX workflow_event_subscriptions_lookup_idx
  ON workflow_event_subscriptions (organization_id, event_type);
CREATE INDEX workflow_event_subscriptions_workflow_idx
  ON workflow_event_subscriptions (organization_id, workflow_id);

ALTER TABLE workflow_event_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_event_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_event_subscriptions_tenant_isolation ON workflow_event_subscriptions
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

-- Схемы 1.0.0 несовместимы с 2.0.0 (порты вместо «проводки», wait-event как точка
-- входа вместо schema.entry, transform без bodyGraph). Workflow заводятся только
-- сидом (R1), продовых схем нет — конвертировать нечего, поэтому драфты и версии
-- сбрасываются, а сид заводит их заново уже в 2.0.0.
--
-- Две преграды, каждая из которых иначе сделала бы сброс молча-неполным:
--   1) у workflow_* стоит FORCE ROW LEVEL SECURITY, а политика пускает только
--      платформенного оператора или совпадающего арендатора — без контекста
--      DELETE удалил бы ноль строк и не пожаловался;
--   2) workflow_versions и workflow_execution_logs защищены триггерами
--      append-only, которые отклоняют DELETE.
SET LOCAL app.is_platform_operator = 'true';

ALTER TABLE workflow_execution_logs DISABLE TRIGGER workflow_execution_logs_append_only;
ALTER TABLE workflow_versions DISABLE TRIGGER workflow_versions_immutable;

-- Порядок важен: workflows.default_version_id ссылается на workflow_versions с
-- ON DELETE RESTRICT, поэтому ссылка снимается до удаления версий.
UPDATE workflows SET draft_schema = NULL, draft_updated_at = NULL, default_version_id = NULL;
DELETE FROM workflow_execution_logs;
DELETE FROM workflow_instance_state;
DELETE FROM workflow_instances;
DELETE FROM workflow_versions;
DELETE FROM workflow_subschemas;

ALTER TABLE workflow_versions ENABLE TRIGGER workflow_versions_immutable;
ALTER TABLE workflow_execution_logs ENABLE TRIGGER workflow_execution_logs_append_only;

-- Статус waiting больше не достижим: ожидание посреди схемы упразднено.
ALTER TABLE workflow_instances DROP CONSTRAINT IF EXISTS workflow_instances_status_check;
ALTER TABLE workflow_instances ADD CONSTRAINT workflow_instances_status_check
  CHECK (status IN ('created', 'started', 'running', 'callback_recorded', 'completed', 'failed', 'cancelled'));

-- down migration

ALTER TABLE workflow_instances DROP CONSTRAINT IF EXISTS workflow_instances_status_check;
ALTER TABLE workflow_instances ADD CONSTRAINT workflow_instances_status_check
  CHECK (status IN ('created', 'started', 'running', 'waiting', 'callback_recorded', 'completed', 'failed', 'cancelled'));

DROP POLICY IF EXISTS workflow_event_subscriptions_tenant_isolation ON workflow_event_subscriptions;
ALTER TABLE IF EXISTS workflow_event_subscriptions DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS workflow_event_subscriptions;
