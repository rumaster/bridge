import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { createBackendApiModule } from "./modules/backend-api/m0-api-module.mjs";
import { createCommunicationCoreModule } from "./modules/communication-core/communication-core-module.mjs";
import { createIdentityModule } from "./modules/identity/identity-module.mjs";

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);

  response.statusCode = status;
  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }
  response.setHeader("content-type", "application/json");
  response.end(payload);
}

function problem(status, title, detail) {
  return {
    type: `https://bridge.local/problems/${title
      .toLowerCase()
      .replaceAll(" ", "-")}`,
    title,
    status,
    detail,
  };
}

function matchRoutePath(routePath, pathname) {
  const routeParts = routePath.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);

  if (routeParts.length !== pathParts.length) {
    return null;
  }

  const params = {};
  for (let index = 0; index < routeParts.length; index += 1) {
    const routePart = routeParts[index];
    const pathPart = pathParts[index];

    if (routePart.startsWith(":")) {
      params[routePart.slice(1)] = decodeURIComponent(pathPart);
      continue;
    }

    if (routePart !== pathPart) {
      return null;
    }
  }

  return params;
}

function findRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }

    const params = matchRoutePath(route.path, pathname);
    if (params) {
      return { route, params };
    }
  }

  return null;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      return {
        ok: false,
        response: {
          status: 413,
          body: problem(413, "Payload Too Large", "Request body is too large."),
        },
      };
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {
      ok: true,
      body: {},
    };
  }

  try {
    return {
      ok: true,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
  } catch {
    return {
      ok: false,
      response: {
        status: 400,
        body: problem(400, "Invalid JSON", "Request body must be valid JSON."),
      },
    };
  }
}

export function createBackendServer({
  modules = createBackendM1Modules(),
} = {}) {
  const routes = modules.flatMap((module) => module.routes);

  return createServer(async (incomingRequest, response) => {
    const url = new URL(incomingRequest.url ?? "/", "http://localhost");
    const matchedRoute = findRoute(routes, incomingRequest.method, url.pathname);

    if (!matchedRoute) {
      sendJson(
        response,
        404,
        problem(404, "Not Found", "No backend skeleton route matched."),
      );
      return;
    }

    const bodyResult =
      incomingRequest.method === "GET"
        ? { ok: true, body: {} }
        : await readJsonBody(incomingRequest);

    if (!bodyResult.ok) {
      sendJson(response, bodyResult.response.status, bodyResult.response.body);
      return;
    }

    const request = {
      method: incomingRequest.method,
      path: url.pathname,
      headers: incomingRequest.headers,
      query: url.searchParams,
      params: matchedRoute.params,
      body: bodyResult.body,
      ip:
        incomingRequest.headers["x-forwarded-for"]
          ?.toString()
          .split(",")[0]
          .trim() ??
        incomingRequest.socket.remoteAddress ??
        null,
    };
    let result;
    try {
      result = await matchedRoute.route.handler({
        request,
        body: bodyResult.body,
        params: matchedRoute.params,
      });
    } catch (error) {
      sendJson(
        response,
        500,
        problem(500, "Internal Server Error", error.message),
      );
      return;
    }

    sendJson(response, result.status, result.body, result.headers);
  });
}

export function createBackendM1Modules({ identityService } = {}) {
  const communicationCoreModule = createCommunicationCoreModule();
  const identityModule = createIdentityModule({ identityService });
  const apiModule = createBackendApiModule({
    moduleNames: [
      "backend-api",
      identityModule.name,
      communicationCoreModule.name,
    ],
  });

  return [apiModule, identityModule, communicationCoreModule];
}

export const createBackendM0Modules = createBackendM1Modules;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const server = createBackendServer();

  server.listen(port, () => {
    console.log(`Bridge backend skeleton listening on http://127.0.0.1:${port}`);
  });
}
