export const DEFAULT_API_BASE_URL: "/api/v1";

export type Fetcher = typeof fetch;

export interface JsonApiClientOptions {
  baseUrl?: string;
  fetcher?: Fetcher;
  defaultHeaders?: HeadersInit;
  origin?: string;
}

export interface JsonApiClient {
  readonly baseUrl: string;
  resolveUrl(path: string): string;
  requestJson<T>(path: string, init?: RequestInit): Promise<T>;
}

export class BridgeApiError<TBody = unknown> extends Error {
  readonly status: number;
  readonly body: TBody;
  readonly url: string;

  constructor(
    message: string,
    options: {
      status: number;
      body: TBody;
      url: string;
    },
  );
}

export function createJsonApiClient(options?: JsonApiClientOptions): JsonApiClient;

export function resolveApiUrl(baseUrl: string, path: string, origin?: string): string;

export function normalizeBaseUrl(baseUrl: string): string;
