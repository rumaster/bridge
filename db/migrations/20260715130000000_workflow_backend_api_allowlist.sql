-- up migration

-- Витрина вызовов Backend API для узла «Вызов Backend API» (решение A3).
--
-- Каталог из 79 операций генерируется из OpenAPI и живёт в коде
-- (packages/contracts/src/backend-api-catalog.generated.ts) — он отвечает на
-- вопрос «что вообще существует». Эта таблица отвечает на другой: «что оператору
-- разрешено дёргать из схемы». Разделение нужно, потому что каталог едет за API
-- автоматически, а разрешение — осознанное решение человека: узел backend-api —
-- единственный, который меняет данные (ТЗ §13.5).
--
-- Таблица ГЛОБАЛЬНАЯ, без organization_id: витрину курирует platform_operator,
-- и она одинакова для всех арендаторов. Ограничение доступа арендатора к
-- конкретным данным обеспечивает не она, а RLS и контекст экземпляра.
CREATE TABLE workflow_backend_api_allowlist (
  operation_id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  -- Кто и когда открыл/закрыл операцию: узел меняет данные, решение должно быть
  -- атрибутируемо.
  curated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  curated_at timestamptz NOT NULL DEFAULT now(),
  note text,
  CONSTRAINT workflow_backend_api_allowlist_operation_id_not_blank CHECK (btrim(operation_id) <> '')
);

CREATE INDEX workflow_backend_api_allowlist_enabled_idx
  ON workflow_backend_api_allowlist (operation_id)
  WHERE enabled;

-- RLS не включается сознательно: таблица глобальная и не содержит данных
-- арендатора, а читать её должен любой арендатор при валидации схемы. Запись
-- закрыта ролью platform_operator на уровне API (@Roles), а не политикой.

-- down migration

DROP TABLE IF EXISTS workflow_backend_api_allowlist;
