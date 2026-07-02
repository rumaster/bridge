export const SEEDED_AUTH_CONTEXT = Object.freeze({
  mode: "mock",
  source: "SVC-DATA M0 seeded demo identity",
  user: Object.freeze({
    id: "00000000-0000-4000-8000-000000000101",
    organizationId: "00000000-0000-4000-8000-000000000001",
    telegramUsername: "seeded_admin",
    displayName: "Seeded Administrator",
    status: "active",
  }),
  organization: Object.freeze({
    id: "00000000-0000-4000-8000-000000000001",
    slug: "demo-organization",
    name: "Demo Organization",
  }),
  roles: Object.freeze(["administrator"]),
  roleBindings: Object.freeze([
    Object.freeze({
      role: "administrator",
      organizationId: "00000000-0000-4000-8000-000000000001",
    }),
  ]),
  session: Object.freeze({
    id: "mock-session-m0",
    mode: "mock",
    issuedAt: "1970-01-01T00:00:00.000Z",
    expiresAt: null,
  }),
});

export function createMockAuthGuard({
  authContext = SEEDED_AUTH_CONTEXT,
} = {}) {
  return {
    canActivate(request) {
      if (!request || typeof request !== "object") {
        throw new TypeError("MockAuthGuard requires a mutable request object.");
      }

      request.auth = authContext;
      return true;
    },
  };
}

export function getAuthContext(request) {
  return request?.auth ?? SEEDED_AUTH_CONTEXT;
}
