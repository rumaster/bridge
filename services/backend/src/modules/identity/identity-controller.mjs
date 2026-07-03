import {
  getAuthContext,
} from "../../common/auth/mock-auth-guard.mjs";
import { createSessionAuthGuard } from "../../common/auth/session-auth-guard.mjs";
import { createIdentityService } from "./identity-service.mjs";

async function withGuard(authGuard, request, handler) {
  const authorization =
    typeof authGuard.authorize === "function"
      ? await authGuard.authorize(request)
      : {
          ok: await authGuard.canActivate(request),
        };

  if (!authorization.ok) {
    return {
      status: authorization.status ?? 401,
      body:
        authorization.body ??
        {
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
  identityService = createIdentityService(),
  authGuard = createSessionAuthGuard({ identityService }),
} = {}) {
  return {
    startTelegramLogin({ body }) {
      return identityService.startTelegramLogin(body);
    },

    verifyTelegramLogin({ body, request }) {
      return identityService.verifyTelegramLogin(body, {
        ip: request.ip,
        userAgent: request.headers?.["user-agent"] ?? null,
      });
    },

    logout({ request }) {
      return withGuard(authGuard, request, () =>
        identityService.logout(getAuthContext(request)),
      );
    },

    getCurrentSession({ request }) {
      return withGuard(authGuard, request, () =>
        identityService.getSession(getAuthContext(request)),
      );
    },
  };
}
