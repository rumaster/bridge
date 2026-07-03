export const DEFAULT_API_BASE_URL = "/api/v1";

export class BridgeApiError extends Error {
  constructor(message, { status, body, url }) {
    super(message);
    this.name = "BridgeApiError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export function createJsonApiClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_API_BASE_URL);
  const fetcher = options.fetcher ?? getGlobalFetch();
  const defaultHeaders = options.defaultHeaders ?? {};
  const origin = options.origin;

  return {
    baseUrl,
    resolveUrl(path) {
      return resolveApiUrl(baseUrl, path, origin);
    },
    async requestJson(path, init = {}) {
      const url = resolveApiUrl(baseUrl, path, origin);
      const response = await fetcher(url, {
        ...init,
        headers: buildHeaders(defaultHeaders, init),
      });

      if (!response.ok) {
        const body = await readResponseBody(response);
        throw new BridgeApiError(
          getErrorMessage(body) ?? `Backend API request failed with ${response.status}`,
          {
            status: response.status,
            body,
            url,
          },
        );
      }

      if (response.status === 204) {
        return undefined;
      }

      return readResponseBody(response);
    },
  };
}

export function resolveApiUrl(baseUrl, path, origin = getDefaultOrigin()) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const baseWithSlash = normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`;

  return new URL(normalizedPath, new URL(baseWithSlash, origin)).toString();
}

export function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new TypeError("baseUrl must be a non-empty string");
  }

  return baseUrl.replace(/\/+$/, "");
}

async function readResponseBody(response) {
  if (response.status === 204) {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  return text === "" ? undefined : text;
}

function buildHeaders(defaultHeaders, init) {
  const headers = new Headers();
  headers.set("Accept", "application/json");

  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  appendHeaders(headers, defaultHeaders);
  appendHeaders(headers, init.headers);

  return headers;
}

function appendHeaders(target, source) {
  if (source === undefined) {
    return;
  }

  new Headers(source).forEach((value, key) => {
    target.set(key, value);
  });
}

function getErrorMessage(body) {
  if (isRecord(body) && typeof body.message === "string" && body.message.trim() !== "") {
    return body.message;
  }

  return null;
}

function getGlobalFetch() {
  if (typeof globalThis.fetch !== "function") {
    throw new TypeError("fetcher option is required when global fetch is unavailable");
  }

  return globalThis.fetch.bind(globalThis);
}

function getDefaultOrigin() {
  return globalThis.location?.origin ?? "http://localhost";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
