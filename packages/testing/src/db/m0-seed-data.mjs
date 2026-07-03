import { assertUtcTimestamptz, assertUuid } from "./primitives.mjs";

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
  email: "seeded-admin@example.bridge.local",
  display_name: "Seeded Admin",
  status: "active",
  created_at: M0_SEED_TIMESTAMP,
  updated_at: M0_SEED_TIMESTAMP,
};

export const SEEDED_ADMIN_ROLE_BINDING_SEED = {
  user_id: SEEDED_ADMIN_USER_SEED.id,
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
