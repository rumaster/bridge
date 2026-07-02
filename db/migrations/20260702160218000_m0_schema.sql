-- up migration

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS app;

CREATE FUNCTION app.current_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.current_organization_id', true), '')::uuid;
$$;

CREATE FUNCTION app.is_platform_operator()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.is_platform_operator', true), '')::boolean,
    false
  );
$$;

COMMENT ON FUNCTION app.current_organization_id() IS
  'RLS tenant context. Backend sets app.current_organization_id per transaction/request.';
COMMENT ON FUNCTION app.is_platform_operator() IS
  'RLS bypass context for platform operators. Backend sets it only for authorized platform scope.';

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  description text,
  timezone text NOT NULL DEFAULT 'UTC',
  locale text NOT NULL DEFAULT 'ru-RU',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT organizations_timezone_not_blank CHECK (btrim(timezone) <> ''),
  CONSTRAINT organizations_locale_not_blank CHECK (btrim(locale) <> ''),
  CONSTRAINT organizations_status_check CHECK (status IN ('active', 'blocked')),
  CONSTRAINT organizations_updated_after_created_check CHECK (updated_at >= created_at)
);

COMMENT ON TABLE organizations IS 'M0 tenant catalog. Row visibility is scoped by app.current_organization_id.';

CREATE TABLE roles (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  scope text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_code_check CHECK (code IN ('platform_operator', 'administrator', 'manager')),
  CONSTRAINT roles_scope_check CHECK (scope IN ('platform', 'organization')),
  CONSTRAINT roles_updated_after_created_check CHECK (updated_at >= created_at)
);

COMMENT ON TABLE roles IS 'M0 deterministic role catalog shared by all tenants.';

CREATE TABLE users (
  id uuid PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  telegram_username text,
  email text,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_display_name_not_blank CHECK (btrim(display_name) <> ''),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'blocked')),
  CONSTRAINT users_updated_after_created_check CHECK (updated_at >= created_at)
);

CREATE INDEX users_organization_id_idx ON users (organization_id);
CREATE UNIQUE INDEX users_organization_email_idx
  ON users (organization_id, lower(email))
  WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_telegram_username_idx
  ON users (lower(telegram_username))
  WHERE telegram_username IS NOT NULL;

COMMENT ON TABLE users IS 'M0 minimal user catalog. organization_id is NULL only for platform-scope users.';

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

CREATE POLICY organizations_tenant_isolation ON organizations
  USING (app.is_platform_operator() OR id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR id = app.current_organization_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_tenant_isolation ON users
  USING (app.is_platform_operator() OR organization_id = app.current_organization_id())
  WITH CHECK (app.is_platform_operator() OR organization_id = app.current_organization_id());

-- down migration

DROP POLICY IF EXISTS users_tenant_isolation ON users;
ALTER TABLE IF EXISTS users DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS users;

DROP POLICY IF EXISTS organizations_tenant_isolation ON organizations;
ALTER TABLE IF EXISTS organizations DISABLE ROW LEVEL SECURITY;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS organizations;

DROP FUNCTION IF EXISTS app.is_platform_operator();
DROP FUNCTION IF EXISTS app.current_organization_id();
DROP SCHEMA IF EXISTS app;

DROP EXTENSION IF EXISTS vector;
