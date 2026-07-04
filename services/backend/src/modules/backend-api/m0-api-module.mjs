const EXTERNAL_FACADE_STATUSES = Object.freeze([
  Object.freeze({
    name: "ai",
    serviceId: "SVC-AI",
    mode: "mock",
    status: "degraded",
  }),
  Object.freeze({
    name: "fbp",
    serviceId: "SVC-FBP",
    mode: "mock",
    status: "degraded",
  }),
  Object.freeze({
    name: "broadcast",
    serviceId: "SVC-BCAST",
    mode: "mock",
    status: "degraded",
  }),
  Object.freeze({
    name: "notification",
    serviceId: "SVC-NOTIF",
    mode: "mock",
    status: "degraded",
  }),
  Object.freeze({
    name: "integration",
    serviceId: "SVC-INT",
    mode: "mock",
    status: "degraded",
  }),
]);

export function createBackendApiModule({
  moduleNames = ["backend-api", "identity", "communication-core"],
  now = () => new Date().toISOString(),
} = {}) {
  const getHealth = () => ({
    status: 200,
    body: {
      status: "ok",
      service: "backend",
      mode: "m0-skeleton",
      modules: moduleNames,
      contracts: ["C3.base", "C3.auth", "C3.platform", "C3.users", "C1", "C2"],
      externalFacades: EXTERNAL_FACADE_STATUSES.map((status) => ({ ...status })),
      timestamp: now(),
    },
  });

  return {
    name: "backend-api",
    contractId: "C3.base",
    basePath: "/api/v1",
    routes: [
      {
        method: "GET",
        path: "/health",
        handler: getHealth,
      },
      {
        method: "GET",
        path: "/api/v1/health",
        handler: getHealth,
      },
    ],
  };
}
