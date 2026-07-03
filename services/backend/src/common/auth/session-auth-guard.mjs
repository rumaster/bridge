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

function headerValue(headers, name) {
  if (!headers) {
    return undefined;
  }

  const normalizedName = name.toLowerCase();
  const directValue = headers[name] ?? headers[normalizedName];

  if (directValue !== undefined) {
    return directValue;
  }

  const matchingHeader = Object.entries(headers).find(
    ([headerName]) => headerName.toLowerCase() === normalizedName,
  );

  return matchingHeader?.[1];
}

export function extractSessionToken(request = {}) {
  const authorization = headerValue(request.headers, "authorization");

  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (match) {
      return match[1].trim();
    }
  }

  const cookie = headerValue(request.headers, "cookie");

  if (typeof cookie === "string") {
    const sessionCookie = cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("bridge_session="));

    if (sessionCookie) {
      return decodeURIComponent(sessionCookie.slice("bridge_session=".length));
    }
  }

  return null;
}

export function requestedOrganizationId(request = {}) {
  return (
    request.organizationId ??
    request.params?.organizationId ??
    request.params?.organization_id ??
    request.query?.organizationId ??
    request.query?.organization_id ??
    request.body?.organizationId ??
    request.body?.organization_id ??
    headerValue(request.headers, "x-organization-id") ??
    null
  );
}

export function createSessionAuthGuard({ identityService } = {}) {
  if (!identityService || typeof identityService.getSessionByToken !== "function") {
    throw new TypeError("createSessionAuthGuard requires identityService.");
  }

  return {
    async authorize(request) {
      if (!request || typeof request !== "object") {
        throw new TypeError("SessionAuthGuard requires a mutable request object.");
      }

      const token = extractSessionToken(request);

      if (!token) {
        return {
          ok: false,
          status: 401,
          body: problem(401, "Unauthorized", "Authentication is required."),
        };
      }

      const session = await identityService.getSessionByToken(token);

      if (session.status !== 200) {
        return {
          ok: false,
          status: session.status,
          body: session.body,
        };
      }

      const organizationId = requestedOrganizationId(request);
      const isPlatformOperator = session.body.roles.includes("platform_operator");

      if (
        organizationId &&
        organizationId !== session.body.organization.id &&
        !isPlatformOperator
      ) {
        return {
          ok: false,
          status: 403,
          body: problem(
            403,
            "Forbidden",
            "Session does not belong to the requested organization.",
          ),
        };
      }

      request.auth = session.body;

      return {
        ok: true,
        authContext: session.body,
      };
    },

    async canActivate(request) {
      const result = await this.authorize(request);

      return result.ok;
    },
  };
}
