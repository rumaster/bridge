import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { backendApiNode } from "../../src/nodes/backend-api.mjs";
import { branchNode } from "../../src/nodes/branch.mjs";
import { knowledgeBaseSearchNode } from "../../src/nodes/knowledge-base-search.mjs";
import { llmNode } from "../../src/nodes/llm.mjs";
import { transformNode } from "../../src/nodes/transform.mjs";
import { waitEventNode } from "../../src/nodes/wait-event.mjs";
import { getNodeDefinition } from "../../src/nodes/registry.mjs";

const ORG = "org-a";

function stubCtx(overrides = {}) {
  return {
    toCallContext() {
      return {
        organization_id: ORG,
        actor_user_id: "user-1",
        trigger: "manual",
        roles: [],
        ...overrides,
      };
    },
  };
}

function capturingClient(response = { status_code: 200, headers: {}, body: { ok: true } }) {
  const calls = [];
  return {
    calls,
    async call(request) {
      calls.push(request);
      return response;
    },
  };
}

function validateConfig(definition, config) {
  const errors = [];
  definition.validate(config, { path: "$.config", errors });
  return errors;
}

describe("Узел Backend API: формирование вызова с контекстом арендатора", () => {
  it("передаёт метод/путь/тело и КОНТЕКСТ арендатора из ExecutionContext", async () => {
    const client = capturingClient({ status_code: 201, headers: {}, body: { id: "r1" } });
    const result = await backendApiNode.execute({
      node: { id: "call", type: "backend-api", config: { method: "POST", path: "/api/v1/records", body: { op: "input" } } },
      input: { title: "Заявка" },
      ctx: stubCtx(),
      backendClient: client,
    });

    assert.equal(client.calls.length, 1);
    const request = client.calls[0];
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/api/v1/records");
    assert.deepEqual(request.body, { title: "Заявка" });
    assert.deepEqual(request.context, {
      organization_id: ORG,
      actor_user_id: "user-1",
      trigger: "manual",
      roles: [],
    });
    assert.equal(result.port, "out");
    assert.deepEqual(result.output, { status_code: 201, headers: {}, body: { id: "r1" } });
    assert.deepEqual(result.log.backend_request, { method: "POST", path: "/api/v1/records" });
  });

  it("подставляет плейсхолдеры пути из входа и не шлёт тело для GET", async () => {
    const client = capturingClient();
    await backendApiNode.execute({
      node: { id: "call", type: "backend-api", config: { method: "GET", path: "/api/v1/records/{id}" } },
      input: { id: "42/7" },
      ctx: stubCtx(),
      backendClient: client,
    });
    assert.equal(client.calls[0].path, "/api/v1/records/42%2F7");
    assert.equal(client.calls[0].body, null);
  });

  it("validate отвергает подмену арендатора/актора/контекста в config", () => {
    for (const key of ["organization_id", "organizationId", "actor_user_id", "context"]) {
      const errors = validateConfig(backendApiNode, { method: "POST", path: "/api/v1/x", [key]: "spoof" });
      assert.ok(errors.some((error) => error.path.endsWith(`.${key}`)), `ключ ${key} должен быть отклонён`);
    }
  });

  it("validate отвергает недопустимый метод и путь вне /api/v1", () => {
    assert.ok(validateConfig(backendApiNode, { method: "TRACE", path: "/api/v1/x" }).some((e) => e.path.endsWith(".method")));
    assert.ok(validateConfig(backendApiNode, { method: "GET", path: "/etc/passwd" }).some((e) => e.path.endsWith(".path")));
  });

  it("validate отвергает операцию Transform вне whitelist в body", () => {
    const errors = validateConfig(backendApiNode, {
      method: "POST",
      path: "/api/v1/x",
      body: { op: "spawn", args: [] },
    });
    assert.ok(errors.some((error) => error.path.includes(".body")));
  });
});

describe("Узел Transform: безопасное преобразование", () => {
  it("исполняет валидированное выражение над input", () => {
    const result = transformNode.execute({
      node: { config: { expression: { op: "upper", args: [{ op: "get", object: { op: "input" }, path: ["name"] }] } } },
      input: { name: "иван" },
    });
    assert.deepEqual(result, { output: "ИВАН", port: "out" });
  });

  it("validate отвергает отсутствие expression", () => {
    assert.ok(validateConfig(transformNode, {}).some((error) => error.path.endsWith(".expression")));
  });
});

describe("Узел Branch: маршрутизация по булеву выражению", () => {
  const node = {
    config: {
      condition: { op: "gt", args: [{ op: "get", object: { op: "input" }, path: ["amount"] }, { op: "lit", value: 100 }] },
    },
  };

  it("эмитит порт true и пробрасывает вход", () => {
    const result = branchNode.execute({ node, input: { amount: 150 } });
    assert.equal(result.port, "true");
    assert.deepEqual(result.output, { amount: 150 });
  });

  it("эмитит порт false", () => {
    const result = branchNode.execute({ node, input: { amount: 10 } });
    assert.equal(result.port, "false");
  });
});

describe("Узлы LLM и Knowledge Base: только через Backend (C3)", () => {
  it("LLM формирует POST к AI-фасаду с контекстом арендатора", async () => {
    const client = capturingClient();
    await llmNode.execute({
      node: { config: { prompt: { op: "get", object: { op: "input" }, path: ["q"] } } },
      input: { q: "Привет" },
      ctx: stubCtx(),
      backendClient: client,
    });
    const request = client.calls[0];
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/api/v1/ai/llm/completions");
    assert.equal(request.body.prompt, "Привет");
    assert.equal(request.context.organization_id, ORG);
  });

  it("Knowledge Base формирует POST с query и top_k", async () => {
    const client = capturingClient();
    await knowledgeBaseSearchNode.execute({
      node: { config: { query: { op: "get", object: { op: "input" }, path: ["text"] }, top_k: 3 } },
      input: { text: "тариф" },
      ctx: stubCtx(),
      backendClient: client,
    });
    const request = client.calls[0];
    assert.equal(request.path, "/api/v1/ai/knowledge-base/search");
    assert.deepEqual(request.body, { query: "тариф", top_k: 3 });
  });

  it("Knowledge Base отвергает недопустимый top_k", () => {
    const errors = validateConfig(knowledgeBaseSearchNode, { query: { op: "input" }, top_k: 0 });
    assert.ok(errors.some((error) => error.path.endsWith(".top_k")));
  });
});

describe("Узел Wait-Event: перевод в ожидание", () => {
  it("возвращает waiting и описание ожидаемого события", () => {
    const result = waitEventNode.execute({
      node: { config: { event_type: "payment.confirmed", timeout_ms: 5000 } },
      input: { order: 1 },
    });
    assert.equal(result.waiting, true);
    assert.equal(result.wait.event_type, "payment.confirmed");
    assert.equal(result.wait.timeout_ms, 5000);
    assert.deepEqual(result.output, { order: 1 });
  });

  it("validate требует непустой event_type", () => {
    assert.ok(validateConfig(waitEventNode, {}).some((error) => error.path.endsWith(".event_type")));
  });
});

describe("Реестр узлов", () => {
  it("отдаёт определение по типу и null для неизвестного", () => {
    assert.equal(getNodeDefinition("backend-api"), backendApiNode);
    assert.equal(getNodeDefinition("transform"), transformNode);
    assert.equal(getNodeDefinition("nonexistent"), null);
  });
});
