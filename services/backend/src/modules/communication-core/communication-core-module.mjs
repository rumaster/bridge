import {
  CommunicationCoreM1NotFoundError,
  CommunicationCoreM1ValidationError,
  createCommunicationCoreM1Service,
} from "./communication-core-m1.mjs";

function validationProblem(error) {
  const errors =
    error instanceof CommunicationCoreM1ValidationError
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

function notFoundProblem(error) {
  return {
    status: 404,
    body: {
      message: error.message,
    },
  };
}

function problemFor(error) {
  if (error instanceof CommunicationCoreM1NotFoundError) {
    return notFoundProblem(error);
  }

  return validationProblem(error);
}

function organizationIdFrom({ request, body }) {
  const header = request.headers["x-organization-id"];
  const headerValue = Array.isArray(header) ? header[0] : header;

  return body.organization_id ?? headerValue ?? request.query?.get("organization_id");
}

export function createCommunicationCoreModule({
  core = createCommunicationCoreM1Service(),
} = {}) {
  async function acceptIngressMessage({ body }) {
    try {
      return {
        status: 202,
        body: await core.acceptIngressMessage(body),
      };
    } catch (error) {
      return problemFor(error);
    }
  }

  async function handoffEgressMessage({ body }) {
    try {
      return {
        status: 202,
        body: await core.handoffEgressMessage(body.message, body.delivery_target),
      };
    } catch (error) {
      return problemFor(error);
    }
  }

  async function listConversations({ request, body }) {
    try {
      return {
        status: 200,
        body: await core.listConversations({
          organizationId: organizationIdFrom({ request, body }),
          limit: request.query?.get("limit"),
        }),
      };
    } catch (error) {
      return problemFor(error);
    }
  }

  async function listConversationMessages({ request, body, params }) {
    try {
      return {
        status: 200,
        body: await core.listConversationMessages({
          organizationId: organizationIdFrom({ request, body }),
          conversationId: params.conversationId,
          limit: request.query?.get("limit"),
        }),
      };
    } catch (error) {
      return problemFor(error);
    }
  }

  async function sendManagerMessage({ body }) {
    try {
      return {
        status: 202,
        body: await core.sendManagerMessage(body),
      };
    } catch (error) {
      return problemFor(error);
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
      {
        method: "GET",
        path: "/api/v1/conversations",
        handler: listConversations,
      },
      {
        method: "GET",
        path: "/api/v1/conversations/:conversationId/messages",
        handler: listConversationMessages,
      },
      {
        method: "POST",
        path: "/api/v1/messages",
        handler: sendManagerMessage,
      },
    ],
  };
}
