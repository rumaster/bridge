export const SEEDED_AUTH_CONTEXT = Object.freeze({
  mode: "seed",
  source: "SVC-DATA M0 seeded demo identity",
  user: Object.freeze({
    id: "00000000-0000-4000-8000-000000000201",
    organizationId: "00000000-0000-4000-8000-000000000101",
    telegramUsername: "seeded_admin",
    displayName: "Seeded Admin",
    status: "active",
  }),
  organization: Object.freeze({
    id: "00000000-0000-4000-8000-000000000101",
    slug: "demo-organization",
    name: "Demo Organization",
    status: "active",
  }),
  roles: Object.freeze(["administrator"]),
  roleBindings: Object.freeze([
    Object.freeze({
      role: "administrator",
      organizationId: "00000000-0000-4000-8000-000000000101",
    }),
  ]),
  session: Object.freeze({
    id: "seed-session-m0",
    mode: "seed",
    issuedAt: "1970-01-01T00:00:00.000Z",
    expiresAt: null,
  }),
});
