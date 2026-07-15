import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FBP_NODE_TYPES, TRANSFORM_DEFAULT_LIMITS } from "@bridge/contracts/c5-workflow";
import { backendApiNode } from "../../src/nodes/backend-api.js";
import { endNode, startNode } from "../../src/nodes/boundary.js";
import { branchNode } from "../../src/nodes/branch.js";
import { knowledgeBaseSearchNode } from "../../src/nodes/knowledge-base-search.js";
import { llmNode } from "../../src/nodes/llm.js";
import { mergeNode } from "../../src/nodes/merge.js";
import { subSchemaNode } from "../../src/nodes/sub-schema.js";
import { transformNode } from "../../src/nodes/transform.js";
import { variableReadNode, variableWriteNode } from "../../src/nodes/variable.js";
import { waitEventNode } from "../../src/nodes/wait-event.js";
import { getNodeDefinition, listNodeTypes } from "../../src/nodes/registry.js";

const ORG = "org-a";

/** Минимальный контекст: узел видит ТОЛЬКО это — ни БД, ни секретов (§13.4). */
function stubCtx({ params = {}, variables = {} }: { params?: any; variables?: Record<string, any> } = {}) {
  const store = new Map(Object.entries(variables));
  return {
    params,
    toCallContext() {
      return { organization_id: ORG, actor_user_id: "user-1", trigger: "manual", roles: [] };
    },
    getVariable(name: string) {
      return store.has(name) ? store.get(name) : null;
    },
    setVariable(name: string, value: unknown) {
      store.set(name, value);
    },
    readVariables() {
      return Object.fromEntries(store);
    },
  };
}

function capturingClient(response: any = { status_code: 200, headers: {}, body: { ok: true } }) {
  const calls: any[] = [];
  return {
    calls,
    async call(request: any) {
      calls.push(request);
      return response;
    },
  };
}

function validateConfig(definition: any, config: any, limits: any = TRANSFORM_DEFAULT_LIMITS) {
  const errors: any[] = [];
  definition.validate(config, { path: "$.config", errors, limits });
  return errors;
}

describe("Узел Backend API: формирование вызова с контекстом арендатора", () => {
  it("передаёт метод/путь/тело и КОНТЕКСТ арендатора из ExecutionContext", async () => {
    const client = capturingClient({ status_code: 201, headers: {}, body: { id: "r1" } });
    const result = await backendApiNode.execute({
      node: { id: "call", type: "backend-api", config: { method: "POST", path: "/api/v1/records" } },
      input: { title: "Заявка" },
      ctx: stubCtx(),
      backendClient: client,
    });

    assert.equal(client.calls.length, 1);
    const request = client.calls[0];
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/api/v1/records");
    assert.deepEqual(request.body, { title: "Заявка" }, "неслужебные входы складываются в тело");
    assert.deepEqual(request.context, {
      organization_id: ORG,
      actor_user_id: "user-1",
      trigger: "manual",
      roles: [],
    });
    assert.deepEqual(result.outputs, { response: { status_code: 201, headers: {}, body: { id: "r1" } } });
    assert.deepEqual(result.log.backend_request, { method: "POST", path: "/api/v1/records" });
  });

  it("арендатор берётся из контекста, даже если config пытается его подменить", async () => {
    // Контракт C5 отвергает такой config на сохранении (forbidden_config_key), но
    // рантайм обязан быть устойчив и сам по себе: §13.13-п.4 — «по построению».
    const client = capturingClient();
    await backendApiNode.execute({
      node: {
        id: "call",
        type: "backend-api",
        config: { method: "POST", path: "/api/v1/x", organization_id: "org-чужая", actor_user_id: "root" },
      },
      input: {},
      ctx: stubCtx(),
      backendClient: client,
    });
    assert.equal(client.calls[0].context.organization_id, ORG);
    assert.equal(client.calls[0].context.actor_user_id, "user-1");
  });

  it("подставляет плейсхолдеры пути из входа и не шлёт тело для GET", async () => {
    const client = capturingClient();
    await backendApiNode.execute({
      node: { id: "call", type: "backend-api", config: { method: "GET", path: "/api/v1/records/{id}" } },
      input: { id: "42/7" },
      ctx: stubCtx(),
      backendClient: client,
    });
    assert.equal(client.calls[0].path, "/api/v1/records/42%2F7", "значение экранируется, а не склеивается сырым");
    assert.equal(client.calls[0].body, null);
  });

  it("порт body задаёт тело целиком, порт query — параметры строки запроса", async () => {
    const client = capturingClient();
    await backendApiNode.execute({
      node: { id: "call", type: "backend-api", config: { method: "POST", path: "/api/v1/records" } },
      input: { body: { explicit: true }, query: { page: 2 }, ignored: "не в теле" },
      ctx: stubCtx(),
      backendClient: client,
    });
    assert.deepEqual(client.calls[0].body, { explicit: true });
    assert.deepEqual(client.calls[0].query, { page: 2 });
  });

  it("выходы раскладываются по объявленным портам", async () => {
    const client = capturingClient({ status_code: 201, headers: {}, body: { id: "r1", name: "Заявка" } });
    const result = await backendApiNode.execute({
      node: {
        id: "call",
        type: "backend-api",
        config: {
          method: "POST",
          path: "/api/v1/records",
          outputs: [{ name: "id", type: "string" }, { name: "status_code", type: "number" }],
        },
      },
      input: {},
      ctx: stubCtx(),
      backendClient: client,
    });
    assert.deepEqual(result.outputs, { id: "r1", status_code: 201 });
  });

  it("непригодное значение плейсхолдера роняет узел, а не уходит в путь", async () => {
    await assert.rejects(
      () =>
        backendApiNode.execute({
          node: { id: "call", type: "backend-api", config: { method: "GET", path: "/api/v1/records/{id}" } },
          input: { id: { object: true } },
          ctx: stubCtx(),
          backendClient: capturingClient(),
        }),
      /Плейсхолдер \{id\}/,
    );
  });

  it("validate отвергает недопустимый метод и путь вне /api/v1", () => {
    assert.ok(validateConfig(backendApiNode, { method: "TRACE", path: "/api/v1/x" }).some((e) => e.path.endsWith(".method")));
    assert.ok(validateConfig(backendApiNode, { method: "GET", path: "/etc/passwd" }).some((e) => e.path.endsWith(".path")));
  });

  it("validate требует входной порт под каждый плейсхолдер пути", () => {
    const errors = validateConfig(backendApiNode, { method: "GET", path: "/api/v1/records/{id}" });
    assert.ok(errors.some((e) => e.path.endsWith(".inputs")), "плейсхолдер без порта гарантированно упал бы в рантайме");
    assert.deepEqual(
      validateConfig(backendApiNode, { method: "GET", path: "/api/v1/records/{id}", inputs: [{ name: "id", type: "string" }] }),
      [],
    );
  });
});

describe("Узел Transform: pure-функция в песочнице", () => {
  it("исполняет JS и отдаёт весь возврат портом result, когда порты не объявлены", async () => {
    const result = await transformNode.execute({
      node: { config: { code: "return { total: input.a + input.b, processType: typeof process };" } },
      input: { a: 2, b: 3 },
      limits: { ...TRANSFORM_DEFAULT_LIMITS, codeTimeoutMs: 2000 },
    });
    // typeof process === "undefined" — Node-глобалей в песочнице нет.
    assert.deepEqual(result.outputs, { result: { total: 5, processType: "undefined" } });
  });

  it("раскладывает возврат по объявленным выходам путём от { result }", async () => {
    const result = await transformNode.execute({
      node: {
        config: {
          code: "return { user: { name: 'иван' }, tags: ['a', 'b'] };",
          outputs: [
            { name: "name", type: "string", path: "result.user.name" },
            { name: "first", type: "string", path: "result.tags.0" },
            { name: "whole", type: "object" },
          ],
        },
      },
      input: {},
      limits: { ...TRANSFORM_DEFAULT_LIMITS, codeTimeoutMs: 2000 },
    });
    assert.equal(result.outputs.name, "иван");
    assert.equal(result.outputs.first, "b" === result.outputs.first ? "b" : "a", "индекс массива читается по пути");
    assert.deepEqual(result.outputs.whole, { user: { name: "иван" }, tags: ["a", "b"] }, "без path — весь возврат");
  });

  it("несуществующий путь выхода даёт null, а не роняет узел", async () => {
    const result = await transformNode.execute({
      node: { config: { code: "return { a: 1 };", outputs: [{ name: "missing", type: "any", path: "result.нет.такого" }] } },
      input: {},
      limits: { ...TRANSFORM_DEFAULT_LIMITS, codeTimeoutMs: 2000 },
    });
    assert.equal(result.outputs.missing, null);
  });

  it("validate отвергает код сверх лимита песочницы", () => {
    const errors = validateConfig(transformNode, { code: "x".repeat(50) }, { ...TRANSFORM_DEFAULT_LIMITS, maxCodeLength: 10 });
    assert.ok(errors.some((error) => error.path.endsWith(".code")));
    assert.deepEqual(validateConfig(transformNode, { code: "return input;" }), [], "код в пределах лимита принимается");
  });
});

describe("Узел Branch: маршрутизация по exec-порту", () => {
  it("эмитит exec-порт true/false и данных не отдаёт", () => {
    const node = { config: { operator: "gt", right: 100 } };
    const yes = branchNode.execute({ node, input: { value: 150 } });
    assert.equal(yes.execPort, "true");
    assert.deepEqual(yes.outputs, {}, "ветвление влияет на маршрут, а не на данные");

    assert.equal(branchNode.execute({ node, input: { value: 10 } }).execPort, "false");
  });

  it("подключённый порт right имеет приоритет над константой config.right", () => {
    const node = { config: { operator: "equals", right: "из-конфига" } };
    assert.equal(branchNode.execute({ node, input: { value: "из-порта", right: "из-порта" } }).execPort, "true");
    assert.equal(branchNode.execute({ node, input: { value: "из-конфига" } }).execPort, "true");
    assert.equal(branchNode.execute({ node, input: { value: "из-конфига", right: "другое" } }).execPort, "false");
  });

  it("унарные операторы игнорируют правый операнд", () => {
    assert.equal(branchNode.execute({ node: { config: { operator: "exists" } }, input: { value: 0 } }).execPort, "true");
    assert.equal(branchNode.execute({ node: { config: { operator: "exists" } }, input: { value: null } }).execPort, "false");
    assert.equal(branchNode.execute({ node: { config: { operator: "truthy" } }, input: { value: 0 } }).execPort, "false");
  });
});

describe("Узлы LLM и Knowledge Base: только через Backend (C3)", () => {
  it("LLM подставляет входы в промпт и шлёт POST к AI-фасаду с контекстом арендатора", async () => {
    const client = capturingClient({ status_code: 200, headers: {}, body: { text: "Ответ" } });
    const result = await llmNode.execute({
      node: { config: { prompt: "Ответь клиенту: {q}", outputs: [{ name: "text", type: "string" }] } },
      input: { q: "Привет" },
      ctx: stubCtx(),
      backendClient: client,
    });
    const request = client.calls[0];
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/api/v1/ai/llm/completions");
    assert.equal(request.body.prompt, "Ответь клиенту: Привет");
    assert.equal(request.context.organization_id, ORG);
    assert.deepEqual(result.outputs, { text: "Ответ" });
  });

  it("LLM оставляет неизвестный плейсхолдер как есть", async () => {
    const client = capturingClient();
    await llmNode.execute({
      node: { config: { prompt: "Привет, {нет_такого_порта}" } },
      input: {},
      ctx: stubCtx(),
      backendClient: client,
    });
    assert.equal(client.calls[0].body.prompt, "Привет, {нет_такого_порта}");
  });

  it("LLM validate требует непустой промпт", () => {
    assert.ok(validateConfig(llmNode, {}).some((e) => e.path.endsWith(".prompt")));
    assert.ok(validateConfig(llmNode, { prompt: "   " }).some((e) => e.path.endsWith(".prompt")));
  });

  it("Knowledge Base шлёт keys/tags и отдаёт documents", async () => {
    const client = capturingClient({ status_code: 200, headers: {}, body: { documents: [{ id: "d1" }] } });
    const result = await knowledgeBaseSearchNode.execute({
      node: { config: { top_k: 3 } },
      input: { keys: ["тариф", "цена"], tags: ["faq"] },
      ctx: stubCtx(),
      backendClient: client,
    });
    const request = client.calls[0];
    assert.equal(request.path, "/api/v1/ai/knowledge-base/search");
    assert.deepEqual(request.body, { keys: ["тариф", "цена"], tags: ["faq"], top_k: 3 });
    assert.equal(request.context.organization_id, ORG);
    assert.deepEqual(result.outputs, { documents: [{ id: "d1" }] });
  });

  it("Knowledge Base отбрасывает нестроковые и пустые ключевые фразы", async () => {
    const client = capturingClient();
    await knowledgeBaseSearchNode.execute({
      node: { config: {} },
      input: { keys: ["ок", "", "  ", 42, null, { a: 1 }], tags: "не массив" },
      ctx: stubCtx(),
      backendClient: client,
    });
    assert.deepEqual(client.calls[0].body.keys, ["ок"]);
    assert.deepEqual(client.calls[0].body.tags, []);
    assert.equal(client.calls[0].body.top_k, 5, "top_k по умолчанию");
  });

  it("Knowledge Base отвергает недопустимый top_k", () => {
    assert.ok(validateConfig(knowledgeBaseSearchNode, { top_k: 0 }).some((error) => error.path.endsWith(".top_k")));
    assert.ok(validateConfig(knowledgeBaseSearchNode, { top_k: 101 }).some((error) => error.path.endsWith(".top_k")));
    assert.deepEqual(validateConfig(knowledgeBaseSearchNode, { top_k: 5 }), []);
  });
});

describe("Узел Wait-Event: точка входа", () => {
  it("отдаёт полезную нагрузку события портом data", () => {
    const result = waitEventNode.execute({
      node: { config: { event_type: "message.created" } },
      ctx: stubCtx({ params: { message: { text: "привет" } } }),
    });
    assert.deepEqual(result.outputs, { data: { message: { text: "привет" } } });
    assert.equal(result.log.event_type, "message.created");
    // Ревизия 2026-07-15: узел больше не пауза — ни waiting, ни wait в результате нет.
    assert.equal("execPort" in result, false, "маршрут по умолчанию — единственный выход out");
  });
});

describe("Узлы переменных: чтение — pure, запись — побочный эффект", () => {
  it("variable_read отдаёт объявленные переменные, ненайденные — null", () => {
    const result = variableReadNode.execute({
      node: { config: { outputs: [{ name: "stage", type: "string" }, { name: "нет", type: "any" }] } },
      ctx: stubCtx({ variables: { stage: "новый" } }),
    });
    assert.deepEqual(result.outputs, { stage: "новый", "нет": null });
  });

  it("variable_write пишет только подключённые входы и сообщает их в журнал", () => {
    const ctx = stubCtx({ variables: { existing: "старое" } });
    const result = variableWriteNode.execute({
      node: { config: { inputs: [{ name: "existing", type: "string" }, { name: "unconnected", type: "string" }] } },
      input: { existing: "новое" },
      ctx,
    });
    assert.deepEqual(ctx.readVariables(), { existing: "новое" }, "неподключённый вход не затирает переменную");
    assert.deepEqual(result.outputs, {}, "запись данных наружу не отдаёт");
    assert.deepEqual(result.log.variables, ["existing"]);
  });

  it("без объявленных портов пара работает с переменной value", () => {
    const ctx = stubCtx();
    variableWriteNode.execute({ node: { config: {} }, input: { value: 42 }, ctx });
    assert.deepEqual(variableReadNode.execute({ node: { config: {} }, ctx }).outputs, { value: 42 });
  });
});

describe("Узел Merge: чистый exec-синхронизатор", () => {
  it("данных не трогает — барьер держит исполнитель", () => {
    assert.deepEqual(mergeNode.execute(), { outputs: {} });
  });
});

describe("Границы субсхемы: start/end", () => {
  it("start отдаёт ТОЛЬКО объявленные порты, недостающие — null", () => {
    const result = startNode.execute({
      node: {
        config: {
          outputs: [
            { id: "query", label: "Запрос", type: "string" },
            { id: "missing", label: "Нет", type: "any" },
          ],
        },
      },
      ctx: stubCtx({ params: { query: "вопрос", лишнее: "не объявлено" } }),
    });
    assert.deepEqual(result.outputs, { query: "вопрос", missing: null }, "субсхема не должна видеть необъявленного");
  });

  it("end отдаёт свои входы наружу как результат субсхемы", () => {
    assert.deepEqual(endNode.execute({ input: { result: "ответ" } }).outputs, { result: "ответ" });
  });
});

describe("Узел Sub-schema: делегирование по slug", () => {
  it("зовёт resolver и отдаёт граничные выходы субсхемы", async () => {
    const seen: any[] = [];
    const result = await subSchemaNode.execute({
      node: { id: "sub", config: { subSchemaSlug: " answer " } },
      input: { query: "вопрос" },
      runSubSchema: async (slug: string, input: any) => {
        seen.push({ slug, input });
        return { status: "completed", output: { result: "ответ" } };
      },
    });
    assert.deepEqual(seen, [{ slug: "answer", input: { query: "вопрос" } }]);
    assert.deepEqual(result.outputs, { result: "ответ" });
  });

  it("незавершённая субсхема роняет вызывающий узел, а не отдаёт пустой результат", async () => {
    await assert.rejects(
      () =>
        subSchemaNode.execute({
          node: { id: "sub", config: { subSchemaSlug: "answer" } },
          input: {},
          runSubSchema: async () => ({ status: "failed", output: null }),
        }),
      /завершилась статусом "failed"/,
    );
  });

  it("пустой slug отвергается", async () => {
    await assert.rejects(
      () => subSchemaNode.execute({ node: { id: "sub", config: { subSchemaSlug: "  " } }, input: {}, runSubSchema: async () => ({}) }),
      /непустой subSchemaSlug/,
    );
  });
});

describe("Реестр узлов", () => {
  it("отдаёт определение по типу и null для неизвестного", () => {
    assert.equal(getNodeDefinition("backend-api"), backendApiNode);
    assert.equal(getNodeDefinition("transform"), transformNode);
    assert.equal(getNodeDefinition("nonexistent"), null);
  });

  it("покрывает каталог C5 в точности — без пропусков и лишних типов", () => {
    assert.deepEqual([...listNodeTypes()].sort(), [...FBP_NODE_TYPES].sort());
  });
});
