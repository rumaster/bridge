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
        identityService.logout(request.auth),
      );
    },

    getCurrentSession({ request }) {
      return withGuard(authGuard, request, () =>
        identityService.getSession(request.auth),
      );
    },

    provisionOrganization({ body, request }) {
      return withGuard(authGuard, request, () =>
        identityService.provisionOrganization(body, request.auth),
      );
    },

    createFirstAdministratorInvitation({ body, params, request }) {
      return withGuard(authGuard, request, () =>
        identityService.createFirstAdministratorInvitation(
          params.id,
          body,
          request.auth,
        ),
      );
    },

    blockOrganization({ params, request }) {
      return withGuard(authGuard, request, () =>
        identityService.blockOrganization(params.id, request.auth),
      );
    },

    createInvitation({ body, request }) {
      return withGuard(authGuard, request, () =>
        identityService.createInvitation(body, request.auth),
      );
    },

    acceptInvitation({ body, request }) {
      return identityService.acceptInvitation(body, {
        ip: request.ip,
        userAgent: request.headers?.["user-agent"] ?? null,
      });
    },
  };
}
