-- up migration

-- Самостоятельная регистрация администратора организации (SVC-ADMIN /register).
--
-- Заявка живёт вне организаций: до подтверждения кода организации в БД нет
-- вообще, поэтому таблица платформенная (organization_id появляется только в
-- момент успешного завершения, как ссылка на созданную организацию).
--
-- Поток: start -> pending (ждём /start у бота) -> code_sent -> completed.
-- Незавершённые заявки удаляются через сутки (expires_at), см. purge в бэкенде.
CREATE TABLE registration_requests (
  id uuid PRIMARY KEY,
  telegram_username text NOT NULL,
  email text NOT NULL,
  organization_name text NOT NULL,
  display_name text,
  -- Payload deep-link ссылки t.me/<bot>?start=<token>. Хранится только HMAC,
  -- как и остальные одноразовые токены (invitations.token_hash, auth_sessions).
  start_token_hash text NOT NULL,
  -- Числовой chat_id, узнаём из апдейта /start; до этого доставить код нельзя.
  telegram_id bigint,
  code_hash text,
  code_expires_at timestamptz,
  -- Итог последней попытки доставки кода (telegram_delivery_failed и т.п.);
  -- иначе фронт при опросе статуса не отличит «код ушёл» от «доставка сорвалась».
  delivery_note text,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  completed_at timestamptz,
  -- audit_events.organization_id — NOT NULL с FK на organizations, поэтому шаги
  -- регистрации до создания организации туда не пишутся. Следом анонимных
  -- попыток служит сама заявка: ip + attempt_count + locked_until + created_at.
  ip inet,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registration_requests_telegram_username_not_blank
    CHECK (btrim(telegram_username) <> ''),
  CONSTRAINT registration_requests_email_not_blank CHECK (btrim(email) <> ''),
  CONSTRAINT registration_requests_organization_name_not_blank
    CHECK (btrim(organization_name) <> ''),
  CONSTRAINT registration_requests_start_token_hash_not_blank
    CHECK (btrim(start_token_hash) <> ''),
  CONSTRAINT registration_requests_start_token_hash_unique UNIQUE (start_token_hash),
  CONSTRAINT registration_requests_status_check
    CHECK (status IN ('pending', 'code_sent', 'completed')),
  CONSTRAINT registration_requests_attempt_count_non_negative CHECK (attempt_count >= 0),
  CONSTRAINT registration_requests_expires_after_created_check CHECK (expires_at > created_at),
  CONSTRAINT registration_requests_updated_after_created_check CHECK (updated_at >= created_at),
  -- code_hash и code_expires_at появляются вместе, в момент доставки кода.
  CONSTRAINT registration_requests_code_pair_check CHECK (
    (code_hash IS NULL) = (code_expires_at IS NULL)
  ),
  -- Код можно выдать только после того, как узнали telegram_id из /start.
  CONSTRAINT registration_requests_code_needs_telegram_id_check CHECK (
    code_hash IS NULL OR telegram_id IS NOT NULL
  ),
  CONSTRAINT registration_requests_completed_shape_check CHECK (
    (status = 'completed') = (completed_at IS NOT NULL)
    AND (status = 'completed') = (organization_id IS NOT NULL)
  )
);

CREATE INDEX registration_requests_expires_at_idx ON registration_requests (expires_at);
CREATE INDEX registration_requests_telegram_id_idx ON registration_requests (telegram_id)
  WHERE telegram_id IS NOT NULL;
CREATE INDEX registration_requests_organization_id_idx ON registration_requests (organization_id)
  WHERE organization_id IS NOT NULL;

COMMENT ON TABLE registration_requests IS
  'Self-service organization registration. Platform-scope: no organization exists until the code is confirmed.';
COMMENT ON COLUMN registration_requests.start_token_hash IS
  'HMAC of the t.me deep-link start payload; the bot resolves the request by it.';
COMMENT ON COLUMN registration_requests.telegram_id IS
  'Numeric private chat_id learned from the /start update. Required before a code can be delivered.';

ALTER TABLE registration_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE registration_requests FORCE ROW LEVEL SECURITY;

-- Таблица не принадлежит тенанту: строки доступны только платформенному контексту
-- (бэкенд читает их через withTenant(..., { isPlatformOperator: true })).
CREATE POLICY registration_requests_platform_only ON registration_requests
  USING (app.is_platform_operator())
  WITH CHECK (app.is_platform_operator());

-- Один Telegram-аккаунт может владеть несколькими организациями, поэтому
-- глобальная уникальность username/telegram_id снимается и становится
-- поорганизационной. NULLS NOT DISTINCT сохраняет уникальность и для
-- платформенных пользователей, у которых organization_id IS NULL.
DROP INDEX users_telegram_username_idx;

CREATE UNIQUE INDEX users_organization_telegram_username_idx
  ON users (organization_id, lower(telegram_username)) NULLS NOT DISTINCT
  WHERE telegram_username IS NOT NULL;

DROP INDEX users_telegram_id_idx;

CREATE UNIQUE INDEX users_organization_telegram_id_idx
  ON users (organization_id, telegram_id) NULLS NOT DISTINCT
  WHERE telegram_id IS NOT NULL;

-- Раз один Telegram-аккаунт может быть администратором нескольких организаций,
-- на один запрос кода приходится по строке login_codes на каждую организацию (код
-- общий, хеш — свой, т.к. привязан к user_id). login_request_id связывает их в
-- группу: именно он возвращается клиенту как requestId и по нему verify находит
-- всех кандидатов, чтобы предложить выбор организации.
ALTER TABLE login_codes
  ADD COLUMN login_request_id uuid;

CREATE INDEX login_codes_login_request_id_idx ON login_codes (login_request_id)
  WHERE login_request_id IS NOT NULL;

COMMENT ON COLUMN login_codes.login_request_id IS
  'Groups the per-organization codes issued by one login start. NULL for rows predating multi-org login.';

-- down migration
--
-- ВНИМАНИЕ: откат восстанавливает ГЛОБАЛЬНУЮ уникальность telegram_username /
-- telegram_id и потому упадёт («could not create unique index ... is
-- duplicated»), если к этому моменту хотя бы один Telegram-аккаунт уже стал
-- администратором двух организаций. Это неустранимо: данные, разрешённые новой
-- семантикой, старой запрещены. Перед откатом дубликаты нужно разрешить вручную.

DROP INDEX IF EXISTS login_codes_login_request_id_idx;

ALTER TABLE IF EXISTS login_codes
  DROP COLUMN IF EXISTS login_request_id;

DROP INDEX IF EXISTS users_organization_telegram_id_idx;

CREATE UNIQUE INDEX users_telegram_id_idx
  ON users (telegram_id)
  WHERE telegram_id IS NOT NULL;

DROP INDEX IF EXISTS users_organization_telegram_username_idx;

CREATE UNIQUE INDEX users_telegram_username_idx
  ON users (lower(telegram_username))
  WHERE telegram_username IS NOT NULL;

DROP POLICY IF EXISTS registration_requests_platform_only ON registration_requests;
ALTER TABLE IF EXISTS registration_requests DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS registration_requests;
