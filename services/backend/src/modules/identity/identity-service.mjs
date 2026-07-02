import { SEEDED_AUTH_CONTEXT } from "../../common/auth/mock-auth-guard.mjs";
import {
  validateTelegramLoginStartRequest,
  validateTelegramLoginVerifyRequest,
} from "./dto/auth-dto.mjs";

const M1_NOTE =
  "M0 stub only. Real Telegram delivery, code_hash verification and server sessions are implemented in M1.";

function validationProblem(errors) {
  return {
    status: 400,
    body: {
      type: "https://bridge.local/problems/validation-error",
      title: "Validation failed",
      status: 400,
      detail: "Request payload does not match C3.auth DTO.",
      errors,
    },
  };
}

function sessionResponse(authContext) {
  return {
    authenticated: true,
    user: authContext.user,
    organization: authContext.organization,
    roles: [...authContext.roles],
    session: authContext.session,
    implementationStage: "M0",
  };
}

export function createIdentityService({
  authContext = SEEDED_AUTH_CONTEXT,
} = {}) {
  return {
    startTelegramLogin(payload) {
      const result = validateTelegramLoginStartRequest(payload);
      if (!result.ok) {
        return validationProblem(result.errors);
      }

      return {
        status: 202,
        body: {
          status: "mock_code_delivery_scheduled",
          deliveryChannel: "telegram",
          telegramUsername: result.value.telegramUsername,
          expiresInSeconds: 300,
          implementationStage: "M0",
          note: M1_NOTE,
        },
      };
    },

    verifyTelegramLogin(payload) {
      const result = validateTelegramLoginVerifyRequest(payload);
      if (!result.ok) {
        return validationProblem(result.errors);
      }

      return {
        status: 200,
        body: sessionResponse(authContext),
      };
    },

    logout() {
      return {
        status: 200,
        body: {
          loggedOut: true,
          sessionMode: "mock",
          implementationStage: "M0",
          note: "M0 acknowledges logout only; real auth_sessions revocation is implemented in M1.",
        },
      };
    },

    getSession(requestAuthContext = authContext) {
      return {
        status: 200,
        body: sessionResponse(requestAuthContext),
      };
    },
  };
}
