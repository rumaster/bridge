import { WorkflowExecutionError } from "../core/errors.js";

/** Ответ Backend API (канал C3): статус, заголовки и разобранное тело. */
export interface BackendApiResponse {
  status_code: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Клиент публичного Backend API — ЕДИНСТВЕННЫЙ канал данных движка (канал C3).
 * Форма запроса: `{ method, path, query?, body?, timeout_ms?, context }`.
 */
export interface BackendApiClient {
  call(request: any): Promise<any>;
}

/**
 * Клиент публичного Backend API (канал C3, ТЗ §13.13-п.3). ЕДИНСТВЕННЫЙ канал,
 * через который движок меняет или читает данные: прямого доступа к БД/внутренним
 * сервисам у движка нет — он не исполняет SQL (§13.12). Авторизация выполняется
 * на стороне Backend по реальному принципалу, а не по «самопровозглашённому»
 * контексту (§13.5).
 *
 * Контракт клиента: `call({ method, path, query, body, timeout_ms, context })`
 * → `{ status_code, headers, body }`. `context.organization_id` задаёт арендатора
 * и НЕ может быть переопределён узлом.
 */

/** Опции HTTP-клиента Backend API. */
export interface HttpBackendApiClientOptions {
  baseUrl: string;
  /**
   * Сервисный токен движка (дефект D4). Backend опознаёт по нему технического
   * пользователя организации и берёт права из его ролей.
   */
  serviceToken: string;
  fetchImpl?: typeof globalThis.fetch;
  defaultTimeoutMs?: number;
}

/**
 * HTTP-реализация поверх `fetch` (боевой режим). В тестах используется
 * `createTenantBackendApiMock` — он же демонстрирует изоляцию арендаторов.
 */
export function createHttpBackendApiClient({
  baseUrl,
  serviceToken,
  fetchImpl = globalThis.fetch,
  defaultTimeoutMs = 250,
}: HttpBackendApiClientOptions) {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new TypeError("createHttpBackendApiClient требует непустой baseUrl.");
  }
  // Без токена каждый вызов узла «Вызов Backend API» получал бы 401 — ровно дефект
  // D4. Падать здесь, на старте, честнее, чем в рантайме на каждой схеме.
  if (typeof serviceToken !== "string" || serviceToken.trim() === "") {
    throw new TypeError("createHttpBackendApiClient требует непустой serviceToken (FBP_SERVICE_TOKEN).");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createHttpBackendApiClient требует доступный fetch.");
  }
  const normalizedBase = baseUrl.replace(/\/+$/, "");

  return {
    async call({ method, path, query = {}, body = null, timeout_ms, context }) {
      const url = new URL(`${normalizedBase}${path}`);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== null && value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeout_ms ?? defaultTimeoutMs);
      try {
        const response = await fetchImpl(url, {
          method,
          headers: {
            "content-type": "application/json",
            // Токен опознаёт сервисного принципала, но прав не несёт: Backend берёт
            // их из ролей технического пользователя организации (§13.5).
            authorization: `Bearer ${serviceToken}`,
            // Арендатор задаётся ТОЛЬКО этим заголовком: у сервисного принципала
            // «организации по умолчанию» нет.
            "x-organization-id": context.organization_id,
            "x-actor-user-id": context.actor_user_id ?? "",
          },
          body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
          signal: controller.signal,
        });
        const text = await response.text();
        return {
          status_code: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: text ? safeJsonParse(text) : null,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/**
 * Мок Backend API с ИЗОЛЯЦИЕЙ АРЕНДАТОРОВ (ТЗ §13.13-п.4, §22.6). Каждый вызов
 * обслуживается СТРОГО в пределах `context.organization_id`: данные одного
 * арендатора недоступны другому «по построению» — обработчик вообще не видит
 * записей чужой организации. Полезен для integration-теста Backend↔FBP и
 * проверки, что org A ≠ org B.
 *
 * `seed`: `{ [organizationId]: { "<METHOD> <path>": <responseBody> } }`.
 */
export function createTenantBackendApiMock({
  seed = {},
  now = () => new Date().toISOString(),
} = {}) {
  const writes = new Map(); // organizationId -> [{ method, path, body, at }]
  const received = [];

  function orgWrites(organizationId) {
    if (!writes.has(organizationId)) {
      writes.set(organizationId, []);
    }
    return writes.get(organizationId);
  }

  return {
    /** Аудит всех полученных вызовов (для проверок формирования запроса). */
    received,
    /** Зафиксированные записи конкретного арендатора (для проверок изоляции). */
    writesFor(organizationId) {
      return [...(writes.get(organizationId) ?? [])];
    },

    async call({ method, path, query = {}, body = null, timeout_ms = null, context }) {
      const organizationId = context?.organization_id;
      if (typeof organizationId !== "string" || organizationId.trim() === "") {
        throw new WorkflowExecutionError(
          "invalid_context",
          "Backend API mock требует organization_id в контексте вызова.",
        );
      }

      received.push({
        organization_id: organizationId,
        actor_user_id: context.actor_user_id ?? null,
        method,
        path,
        query,
        body,
        timeout_ms,
      });

      // Сначала — засеянный ответ ЭТОГО арендатора (никогда чужого).
      const orgSeed = seed[organizationId] ?? {};
      const key = `${method} ${path}`;
      if (Object.hasOwn(orgSeed, key)) {
        return respond(200, { organization_id: organizationId, ...orgSeed[key] });
      }

      // Мутации фиксируются в пределах арендатора.
      if (method !== "GET") {
        orgWrites(organizationId).push({ method, path, body, at: now() });
        return respond(201, {
          created: true,
          organization_id: organizationId,
          echo: body ?? null,
        });
      }

      // Чтение по умолчанию видит ТОЛЬКО записи своего арендатора.
      const records = orgWrites(organizationId).filter((entry) => entry.path === path);
      return respond(200, { organization_id: organizationId, records });
    },
  };
}

function respond(statusCode, body) {
  return {
    status_code: statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body,
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
