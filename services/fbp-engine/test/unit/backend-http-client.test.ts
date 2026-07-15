import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHttpBackendApiClient } from "../../src/backend/client.js";

/**
 * Боевой HTTP-клиент Backend API (канал C3). До этого он был не покрыт вовсе — и
 * именно в нём жил дефект D4: клиент слал только `x-organization-id`, а
 * `SessionAuthGuard` требует `Authorization: Bearer`, поэтому каждый узел «Вызов
 * Backend API» получал в бою 401.
 */

const SERVICE_TOKEN = "test-service-token";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000101";

function fetchSpy(response = { status: 200, body: JSON.stringify({ ok: true }) }) {
  const calls: { url: string; init: Record<string, any> }[] = [];

  const impl = async (url: URL, init: Record<string, any>) => {
    calls.push({ url: String(url), init });
    return {
      status: response.status,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => response.body,
    } as unknown as Response;
  };

  return { calls, impl: impl as unknown as typeof globalThis.fetch };
}

function callContext() {
  return { organization_id: ORGANIZATION_ID, actor_user_id: null };
}

describe("HTTP-клиент Backend API: сервисная аутентификация (D4)", () => {
  it("предъявляет сервисный токен в Authorization", async () => {
    const fetch = fetchSpy();
    const client = createHttpBackendApiClient({
      baseUrl: "http://backend:3000",
      serviceToken: SERVICE_TOKEN,
      fetchImpl: fetch.impl,
    });

    await client.call({
      method: "GET",
      path: "/api/v1/clients/42",
      query: {},
      body: null,
      timeout_ms: null,
      context: callContext(),
    });

    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].init.headers.authorization, `Bearer ${SERVICE_TOKEN}`);
  });

  it("задаёт арендатора заголовком x-organization-id из контекста экземпляра", async () => {
    // Организация приходит только отсюда: у сервисного принципала «организации по
    // умолчанию» нет, а узел её задать не может (§13.13-п.4).
    const fetch = fetchSpy();
    const client = createHttpBackendApiClient({
      baseUrl: "http://backend:3000",
      serviceToken: SERVICE_TOKEN,
      fetchImpl: fetch.impl,
    });

    await client.call({
      method: "GET",
      path: "/api/v1/clients/42",
      query: {},
      body: null,
      timeout_ms: null,
      context: callContext(),
    });

    assert.equal(fetch.calls[0].init.headers["x-organization-id"], ORGANIZATION_ID);
  });

  it("отказывается собираться без сервисного токена", async () => {
    // Падение на старте честнее, чем безымянный 401 из чужого сервиса на каждой
    // схеме — ровно то, как дефект D4 и проявлялся.
    assert.throws(
      () =>
        createHttpBackendApiClient({
          baseUrl: "http://backend:3000",
          serviceToken: "",
          fetchImpl: fetchSpy().impl,
        }),
      /serviceToken/,
    );
  });
});
