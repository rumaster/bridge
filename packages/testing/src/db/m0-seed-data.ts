import { assertUtcTimestamptz, assertUuid } from "./primitives.js";

export const M0_SEED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

export const ROLE_SEEDS = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    code: "platform_operator",
    scope: "platform",
    description: "Platform-wide operator role for SaaS administration.",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    code: "administrator",
    scope: "organization",
    description: "Organization administrator role.",
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    code: "manager",
    scope: "organization",
    description: "Manager workspace role.",
  },
].map((role) => ({
  ...role,
  created_at: M0_SEED_TIMESTAMP,
  updated_at: M0_SEED_TIMESTAMP,
}));

export const DEMO_ORGANIZATION_SEED = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "Demo Organization",
  description: "Deterministic M0 organization for local and CI scenarios.",
  timezone: "UTC",
  locale: "ru-RU",
  status: "active",
  created_at: M0_SEED_TIMESTAMP,
  updated_at: M0_SEED_TIMESTAMP,
};

export const SEEDED_ADMIN_USER_SEED = {
  id: "00000000-0000-4000-8000-000000000201",
  organization_id: DEMO_ORGANIZATION_SEED.id,
  telegram_username: "seeded_admin",
  telegram_id: "555000111",
  email: "seeded-admin@example.bridge.local",
  display_name: "Seeded Admin",
  status: "active",
  is_service: false,
  created_at: M0_SEED_TIMESTAMP,
  updated_at: M0_SEED_TIMESTAMP,
};

export const SEEDED_ADMIN_ROLE_BINDING_SEED = {
  user_id: SEEDED_ADMIN_USER_SEED.id,
  role_id: ROLE_SEEDS.find((role) => role.code === "administrator").id,
  organization_id: DEMO_ORGANIZATION_SEED.id,
  created_at: M0_SEED_TIMESTAMP,
};

/**
 * Технический пользователь движка Workflow (дефект D4). Схему запускает событие,
 * человека-инициатора у неё нет, поэтому узел «Вызов Backend API» ходит от имени
 * этой строки: сервисный токен отвечает «кто ты», а права берутся отсюда и из
 * user_roles.
 *
 * Все три идентификатора входа (telegram_username, telegram_id, email) — NULL
 * намеренно: ни один человеческий путь аутентификации не должен резолвиться в
 * этого пользователя. Telegram-вход ищет по username/telegram_id, регистрация — по
 * email; NULL закрывает и то и другое. Войти под ним можно только сервисным
 * токеном.
 */
export const SEEDED_WORKFLOW_SERVICE_USER_SEED = {
  id: "00000000-0000-4000-8000-000000000202",
  organization_id: DEMO_ORGANIZATION_SEED.id,
  telegram_username: null,
  telegram_id: null,
  email: null,
  display_name: "Workflow Engine (service)",
  status: "active",
  is_service: true,
  created_at: M0_SEED_TIMESTAMP,
  updated_at: M0_SEED_TIMESTAMP,
};

/**
 * Роль `administrator`, а не `manager`: `WorkflowActionApplierService` требует
 * администратора на любое действие кроме `noop`, поэтому с `manager` узел
 * «Вызов Backend API» не смог бы сделать ничего. Границей вызовов служит не роль,
 * а витрина `workflow_backend_api_allowlist`, проверяемая в рантайме.
 */
export const SEEDED_WORKFLOW_SERVICE_ROLE_BINDING_SEED = {
  user_id: SEEDED_WORKFLOW_SERVICE_USER_SEED.id,
  role_id: ROLE_SEEDS.find((role) => role.code === "administrator").id,
  organization_id: DEMO_ORGANIZATION_SEED.id,
  created_at: M0_SEED_TIMESTAMP,
};

for (const role of ROLE_SEEDS) {
  assertUuid(role.id, `role ${role.code} id`);
  assertUtcTimestamptz(role.created_at, `role ${role.code} created_at`);
  assertUtcTimestamptz(role.updated_at, `role ${role.code} updated_at`);
}

assertUuid(DEMO_ORGANIZATION_SEED.id, "demo organization id");
assertUtcTimestamptz(DEMO_ORGANIZATION_SEED.created_at, "demo organization created_at");
assertUtcTimestamptz(DEMO_ORGANIZATION_SEED.updated_at, "demo organization updated_at");

assertUuid(SEEDED_ADMIN_USER_SEED.id, "seeded admin id");
assertUuid(SEEDED_ADMIN_USER_SEED.organization_id, "seeded admin organization_id");
assertUtcTimestamptz(SEEDED_ADMIN_USER_SEED.created_at, "seeded admin created_at");
assertUtcTimestamptz(SEEDED_ADMIN_USER_SEED.updated_at, "seeded admin updated_at");

assertUuid(SEEDED_ADMIN_ROLE_BINDING_SEED.user_id, "seeded admin role user_id");
assertUuid(SEEDED_ADMIN_ROLE_BINDING_SEED.role_id, "seeded admin role role_id");
assertUuid(
  SEEDED_ADMIN_ROLE_BINDING_SEED.organization_id,
  "seeded admin role organization_id",
);
assertUtcTimestamptz(
  SEEDED_ADMIN_ROLE_BINDING_SEED.created_at,
  "seeded admin role created_at",
);

assertUuid(SEEDED_WORKFLOW_SERVICE_USER_SEED.id, "workflow service principal id");
assertUuid(
  SEEDED_WORKFLOW_SERVICE_USER_SEED.organization_id,
  "workflow service principal organization_id",
);
assertUtcTimestamptz(
  SEEDED_WORKFLOW_SERVICE_USER_SEED.created_at,
  "workflow service principal created_at",
);
assertUtcTimestamptz(
  SEEDED_WORKFLOW_SERVICE_USER_SEED.updated_at,
  "workflow service principal updated_at",
);

assertUuid(
  SEEDED_WORKFLOW_SERVICE_ROLE_BINDING_SEED.user_id,
  "workflow service principal role user_id",
);
assertUuid(
  SEEDED_WORKFLOW_SERVICE_ROLE_BINDING_SEED.role_id,
  "workflow service principal role role_id",
);
assertUuid(
  SEEDED_WORKFLOW_SERVICE_ROLE_BINDING_SEED.organization_id,
  "workflow service principal role organization_id",
);
assertUtcTimestamptz(
  SEEDED_WORKFLOW_SERVICE_ROLE_BINDING_SEED.created_at,
  "workflow service principal role created_at",
);
