export const DEFAULT_API_BASE_URL = "/api/v1";

export * from "./generated/openapi.js";

/** Global `fetch`-совместимая функция, которую можно подменить в тестах. */
export type Fetcher = typeof fetch;

/** Стандартная форма заголовков (`HeadersInit`), заданная без DOM-lib. */
export type HeaderBag = Headers | string[][] | Record<string, string>;

/** Заголовки по умолчанию: статические, либо (а)синхронно вычисляемые. */
export type JsonApiDefaultHeaders =
  | HeaderBag
  | (() => HeaderBag | Promise<HeaderBag> | undefined)
  | undefined;

/** Опции конструктора {@link createJsonApiClient}. */
export interface JsonApiClientOptions {
  baseUrl?: string;
  fetcher?: Fetcher;
  defaultHeaders?: JsonApiDefaultHeaders;
  origin?: string;
}

/** Публичный контракт JSON-клиента backend API (общий для всех фронтендов). */
export interface JsonApiClient {
  readonly baseUrl: string;
  resolveUrl(path: string): string;
  requestJson<T>(path: string, init?: RequestInit): Promise<T>;
}

/** Опции ошибки {@link BridgeApiError} (HTTP-статус, тело ответа и URL). */
export interface BridgeApiErrorOptions<TBody = unknown> {
  status: number;
  body: TBody;
  url: string;
}

export class BridgeApiError<TBody = unknown> extends Error {
  readonly status: number;
  readonly body: TBody;
  readonly url: string;

  constructor(message: string, { status, body, url }: BridgeApiErrorOptions<TBody>) {
    super(message);
    this.name = "BridgeApiError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export function createJsonApiClient(options: JsonApiClientOptions = {}): JsonApiClient {
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
      const resolvedDefaultHeaders = await resolveDefaultHeaders(defaultHeaders);
      const response = await fetcher(url, {
        ...init,
        headers: buildHeaders(resolvedDefaultHeaders, init),
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

async function resolveDefaultHeaders(defaultHeaders: JsonApiDefaultHeaders) {
  if (typeof defaultHeaders === "function") {
    return defaultHeaders();
  }

  return defaultHeaders;
}

export function resolveApiUrl(baseUrl: string, path: string, origin = getDefaultOrigin()): string {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const baseWithSlash = normalizedBase.endsWith("/") ? normalizedBase : `${normalizedBase}/`;

  return new URL(normalizedPath, new URL(baseWithSlash, origin)).toString();
}

export function normalizeBaseUrl(baseUrl: string): string {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new TypeError("baseUrl must be a non-empty string");
  }

  return baseUrl.replace(/\/+$/, "");
}

async function readResponseBody(response: Response): Promise<any> {
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

function buildHeaders(defaultHeaders: HeaderBag | undefined, init: RequestInit) {
  const headers = new Headers();
  headers.set("Accept", "application/json");

  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  appendHeaders(headers, defaultHeaders);
  appendHeaders(headers, init.headers);

  return headers;
}

function appendHeaders(target: Headers, source: unknown) {
  if (source === undefined) {
    return;
  }

  // Тип `HeadersInit` расходится между DOM и undici (значения записи, формы
  // массивов); нормализуем на границе конструктора — рантайм принимает обе формы.
  new Headers(source as any).forEach((value, key) => {
    target.set(key, value);
  });
}

function getErrorMessage(body: unknown) {
  if (isRecord(body) && typeof body.message === "string" && body.message.trim() !== "") {
    return body.message;
  }

  if (isRecord(body) && typeof body.detail === "string" && body.detail.trim() !== "") {
    return body.detail;
  }

  return null;
}

function getGlobalFetch(): Fetcher {
  if (typeof globalThis.fetch !== "function") {
    throw new TypeError("fetcher option is required when global fetch is unavailable");
  }

  return globalThis.fetch.bind(globalThis);
}

function getDefaultOrigin() {
  return globalThis.location?.origin ?? "http://localhost";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
