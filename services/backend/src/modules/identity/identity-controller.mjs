import {
  createMockAuthGuard,
  getAuthContext,
} from "../../common/auth/mock-auth-guard.mjs";
import { createIdentityService } from "./identity-service.mjs";

function withGuard(authGuard, request, handler) {
  if (!authGuard.canActivate(request)) {
    return {
      status: 401,
      body: {
        type: "https://bridge.local/problems/unauthorized",
        title: "Unauthorized",
        status: 401,
        detail: "Authentication is required.",
      },
    };
  }

  return handler();
}

export function createIdentityController({
  authGuard = createMockAuthGuard(),
  identityService = createIdentityService(),
} = {}) {
  return {
    startTelegramLogin({ body }) {
      return identityService.startTelegramLogin(body);
    },

    verifyTelegramLogin({ body }) {
      return identityService.verifyTelegramLogin(body);
    },

    logout({ request }) {
      return withGuard(authGuard, request, () => identityService.logout());
    },

    getCurrentSession({ request }) {
      return withGuard(authGuard, request, () =>
        identityService.getSession(getAuthContext(request)),
      );
    },
  };
}
