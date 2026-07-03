import { createSessionAuthGuard } from "../../common/auth/session-auth-guard.mjs";
import { createIdentityController } from "./identity-controller.mjs";
import { createIdentityService } from "./identity-service.mjs";

export function createIdentityModule({
  identityService = createIdentityService(),
  authGuard = createSessionAuthGuard({ identityService }),
} = {}) {
  const controller = createIdentityController({
    authGuard,
    identityService,
  });

  return {
    name: "identity",
    contractId: "C3.auth",
    basePath: "/api/v1",
    authGuard,
    routes: [
      {
        method: "POST",
        path: "/api/v1/auth/login/telegram/start",
        handler: controller.startTelegramLogin,
      },
      {
        method: "POST",
        path: "/api/v1/auth/login/telegram/verify",
        handler: controller.verifyTelegramLogin,
      },
      {
        method: "POST",
        path: "/api/v1/auth/logout",
        handler: controller.logout,
      },
      {
        method: "GET",
        path: "/api/v1/auth/session",
        handler: controller.getCurrentSession,
      },
    ],
  };
}
