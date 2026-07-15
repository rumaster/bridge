-- up migration

-- Технический пользователь движка Workflow (дефект D4).
--
-- Узел «Вызов Backend API» — единственный санкционированный способ схемы менять
-- данные (ТЗ §13.5), но после переработки 2.0 узел «Ожидание события» стал точкой
-- входа: схему запускает событие, и человека-инициатора у неё нет вообще. Значит
-- вызов Backend идёт от имени сервисного принципала.
--
-- Принципала опознаёт сервисный токен (FBP_SERVICE_TOKEN), но ПРАВА он берёт не
-- из токена, а из этой строки в users и её привязок в user_roles: токен отвечает
-- на вопрос «кто ты», роли — на вопрос «что тебе можно». Иначе рядом с сессионным
-- контуром авторизации появился бы второй, со своим списком прав, и они бы
-- разошлись.
--
-- Пользователь нужен настоящий ещё и потому, что audit_events.actor_user_id
-- ссылается на users(id, organization_id) составным внешним ключом: синтетический
-- идентификатор ронял бы любую аудируемую запись.
ALTER TABLE users ADD COLUMN is_service boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN users.is_service IS
  'Технический пользователь (движок Workflow). Входит по сервисному токену, не по сессии; человеку не принадлежит.';

-- Не более одного технического пользователя на организацию: принципал должен
-- разрешаться однозначно, иначе гуард выбирал бы произвольную строку.
CREATE UNIQUE INDEX users_service_principal_per_organization_idx
  ON users (organization_id)
  WHERE is_service;

-- down migration

DROP INDEX IF EXISTS users_service_principal_per_organization_idx;
ALTER TABLE users DROP COLUMN IF EXISTS is_service;
