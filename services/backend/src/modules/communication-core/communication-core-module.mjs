import {
  CommunicationCoreMockValidationError,
  createCommunicationCoreMock,
} from "./mock-ingress-egress.mjs";

function validationProblem(error) {
  const errors =
    error instanceof CommunicationCoreMockValidationError
      ? error.errors
      : [error.message];

  return {
    status: 400,
    body: {
      message: "Invalid C1/C2 DTO.",
      errors,
    },
  };
}

export function createCommunicationCoreModule({
  core = createCommunicationCoreMock(),
} = {}) {
  function acceptIngressMessage({ body }) {
    try {
      return {
        status: 202,
        body: core.acceptIngressMessage(body),
      };
    } catch (error) {
      return validationProblem(error);
    }
  }

  function handoffEgressMessage({ body }) {
    try {
      return {
        status: 202,
        body: core.handoffEgressMessage(body.message, body.delivery_target),
      };
    } catch (error) {
      return validationProblem(error);
    }
  }

  return {
    name: "communication-core",
    contractId: "C1/C2",
    basePath: "/api/v1",
    core,
    routes: [
      {
        method: "POST",
        path: "/internal/ingress/messages",
        handler: acceptIngressMessage,
      },
      {
        method: "POST",
        path: "/api/v1/internal/ingress/messages",
        handler: acceptIngressMessage,
      },
      {
        method: "POST",
        path: "/internal/egress/messages",
        handler: handoffEgressMessage,
      },
      {
        method: "POST",
        path: "/api/v1/internal/egress/messages",
        handler: handoffEgressMessage,
      },
    ],
  };
}
