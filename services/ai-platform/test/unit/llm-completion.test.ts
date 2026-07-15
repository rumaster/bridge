import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateLlmCompletionResponse } from "../../../../packages/contracts/src/c4.js";
import { createInMemoryKbSearch } from "../../src/kb-search.js";
import { createDeterministicMockLlm, createUnavailableLlm } from "../../src/llm.js";
import { createRagAssistant } from "../../src/rag-assistant.js";

/**
 * Сырой вызов LLM (C4.CompleteLlm) для узла «LLM» контракта Workflow 2.0.
 *
 * Живёт рядом с RAG-ассистентом, потому что делит с ним выбор провайдера,
 * устойчивый фасад и метрики. Отличие проверяется прямо: базы знаний здесь нет.
 */

const NOW = "2026-07-03T10:00:00.000Z";
const ORG = "org-1";

function makeAssistant(llm = createDeterministicMockLlm()) {
  return createRagAssistant({
    llm,
    kbSearch: createInMemoryKbSearch({ chunks: [] }),
    now: () => NOW,
  });
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    contract: "C4.LlmCompletionRequest",
    version: "1.0.0",
    request_id: "req-llm-1",
    organization_id: ORG,
    prompt: "Перескажи обращение клиента одним предложением.",
    params: {},
    ...overrides,
  };
}

describe("C4 CompleteLlm: сырой вызов LLM для узла схемы", () => {
  it("возвращает ответ модели в форме, которую требует контракт", async () => {
    const response = await makeAssistant().completeLlm(request());

    assert.equal(validateLlmCompletionResponse(response).valid, true);
    assert.equal(response.contract, "C4.LlmCompletionResponse");
    assert.equal(response.degraded, false);
    assert.equal(response.fallback_reason, null);
    assert.ok(response.completion.text.length > 0);
  });

  it("не ходит в базу знаний: промпт задаёт схема целиком", async () => {
    // Отличие от suggestAssistant. Если бы поиск вызывался, счётчик бы вырос.
    const assistant = makeAssistant();
    await assistant.completeLlm(request());

    assert.equal(assistant.getMetrics().kb_search_total, 0);
    assert.equal(assistant.getMetrics().llm_completion_total, 1);
  });

  it("деградирует до заглушки, когда провайдер недоступен", async () => {
    // Узел схемы обязан получить валидный ответ, а не исключение (ТЗ §5.4).
    const assistant = makeAssistant(createUnavailableLlm());
    const response = await assistant.completeLlm(request());

    assert.equal(validateLlmCompletionResponse(response).valid, true);
    assert.equal(response.degraded, true);
    assert.equal(response.fallback_reason, "unavailable");
    // model = null отличает заглушку от ответа модели.
    assert.equal(response.completion.model, null);
    assert.equal(assistant.getMetrics().llm_completion_degraded_total, 1);
  });

  it("считает пустой ответ модели отказом, а не ответом", async () => {
    // Иначе узел продолжил бы исполнение с пустой строкой и ветвление по тексту
    // молча ушло бы не туда.
    const empty = { ...createDeterministicMockLlm(), async complete() {
      return { text: "   ", model: "broken" };
    } };
    const response = await makeAssistant(empty).completeLlm(request());

    assert.equal(response.degraded, true);
    assert.equal(response.fallback_reason, "invalid_response");
  });

  it("отвергает запрос без промпта", async () => {
    await assert.rejects(() => makeAssistant().completeLlm(request({ prompt: "" })), {
      name: "C4DtoValidationError",
    });
  });

  it("отвергает неизвестные поля запроса", async () => {
    // Контракт закрыт: лишнее поле — признак рассинхронизации сторон, а не мусор,
    // который можно тихо проигнорировать.
    await assert.rejects(() => makeAssistant().completeLlm(request({ query: "лишнее" })), {
      name: "C4DtoValidationError",
    });
  });

  it("метрика вызовов регистрируется — счётчик существует до первого запроса", () => {
    // Регрессия: счётчики llm_completion_* не были заведены в COUNTER_KEYS, и
    // inc() ронял вызов с «Unknown AI metric». Юнит-тесты этого не видели —
    // поймано пробником по gRPC.
    const snapshot = makeAssistant().getMetrics();

    assert.equal(snapshot.llm_completion_total, 0);
    assert.equal(snapshot.llm_completion_degraded_total, 0);
  });
});
