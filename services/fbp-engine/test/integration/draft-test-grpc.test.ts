import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import { WORKFLOW_SCHEMA_VERSION } from "@bridge/contracts/c5-workflow";
import { createTenantBackendApiMock } from "../../src/backend/client.js";
import { startFbpEngineGrpcServer } from "../../src/grpc-server.js";

/**
 * Тест-прогон драфта по gRPC (дефект D5, решение A5).
 *
 * Проверяется главное свойство: драфт исполняет НАСТОЯЩИЙ движок — с ветвлением, с
 * ленивым вычислением pure-узлов, — но экземпляра не создаёт. До этой работы
 * «тестовый прогон» печатал `completed` для каждого узла в порядке массива, без
 * ветвлений и без движка вовсе.
 */

const ORG = "org-draft-test";
const PROTO_PATH = "packages/contracts/proto/fbp/c5.fbp.proto";

function node(id: string, type: string, config: Record<string, unknown> = {}) {
  return { id, type, position: { x: 0, y: 0 }, config };
}

function link(id: string, from: string, fromPort: string, to: string, toPort: string) {
  return { id, from, fromPort, to, toPort };
}

/** Схема с ветвлением: обе ветки пишут разную переменную — по трассе видно, куда пошли. */
function branchingDraft() {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    kind: "workflow",
    nodes: [
      node("wait", "wait-event", { event_type: "message.created" }),
      node("pick", "transform", {
        code: "return input.data?.urgent === true;",
        inputs: [{ name: "data", type: "object" }],
        outputs: [{ name: "value", type: "boolean" }],
      }),
      node("check", "branch", { operator: "truthy" }),
      node("hot", "variable_write", { name: "route", inputs: [{ name: "value", type: "string" }] }),
      node("cold", "variable_write", { name: "route", inputs: [{ name: "value", type: "string" }] }),
      node("hotText", "transform", { code: "return 'срочно';", outputs: [{ name: "value", type: "string" }] }),
      node("coldText", "transform", { code: "return 'обычно';", outputs: [{ name: "value", type: "string" }] }),
    ],
    connections: [
      link("c1", "wait", "out", "check", "in"),
      link("c2", "wait", "data", "pick", "data"),
      link("c3", "pick", "value", "check", "value"),
      link("c4", "check", "true", "hot", "in"),
      link("c5", "check", "false", "cold", "in"),
      link("c6", "hotText", "value", "hot", "value"),
      link("c7", "coldText", "value", "cold", "value"),
    ],
  };
}

function loadClient(target: string) {
  const definition = protoLoader.loadSync(PROTO_PATH, {
    defaults: true,
    enums: String,
    keepCase: true,
    longs: String,
    oneofs: true,
  });
  const descriptor = grpc.loadPackageDefinition(definition) as any;
  return new descriptor.bridge.fbp.v1.FbpEngine(target, grpc.credentials.createInsecure());
}

describe("TestWorkflowDraft: тест-прогон драфта по gRPC", () => {
  let handle: Awaited<ReturnType<typeof startFbpEngineGrpcServer>>;
  let client: any;

  before(async () => {
    handle = await startFbpEngineGrpcServer({
      backendClient: createTenantBackendApiMock(),
      host: "127.0.0.1",
      now: () => "2026-07-15T00:00:00.000Z",
      port: 0,
      protoPath: PROTO_PATH,
    });
    client = loadClient(handle.address);
  });

  after(async () => {
    client?.close();
    await new Promise<void>((resolve) => handle.server.tryShutdown(() => resolve()));
  });

  function testDraft(payload: Record<string, unknown>) {
    return new Promise<any>((resolve, reject) => {
      client.TestWorkflowDraft(
        {
          contract: "C5.TestWorkflowDraftRequest",
          version: "1.0.0",
          request_id: "req-draft-1",
          organization_id: ORG,
          workflow_id: "wf-1",
          actor_user_id: "operator-1",
          schema_json: JSON.stringify(branchingDraft()),
          context_json: JSON.stringify({ organization_id: ORG, trigger: "draft_test" }),
          ...payload,
        },
        (error: grpc.ServiceError | null, response?: { json_payload?: string }) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(JSON.parse(response!.json_payload!));
        },
      );
    });
  }

  it("исполняет драфт по-настоящему: ветвление зависит от полезной нагрузки", async () => {
    const hot = await testDraft({
      start_node_id: "wait",
      event_payload_json: JSON.stringify({ urgent: true }),
    });

    assert.equal(hot.contract, "C5.TestWorkflowDraftResponse");
    assert.equal(hot.status, "completed");

    const hotVisited = hot.trace.map((entry: any) => entry.nodeId);
    assert.equal(hotVisited.includes("hot"), true);
    assert.equal(hotVisited.includes("cold"), false, "ветка false не исполнялась");

    // Та же схема, другая нагрузка — другая ветка. Прежний «тест» этого не умел:
    // он печатал completed для всех узлов подряд.
    const cold = await testDraft({
      start_node_id: "wait",
      event_payload_json: JSON.stringify({ urgent: false }),
    });

    const coldVisited = cold.trace.map((entry: any) => entry.nodeId);
    assert.equal(coldVisited.includes("cold"), true);
    assert.equal(coldVisited.includes("hot"), false);
  });

  it("не создаёт экземпляр: в ответе нет ни instance_id, ни журнала для сохранения", async () => {
    // Ровно это и позволяет гонять недостроенный драфт: журнал исполнения ссылается
    // на workflow_instances внешним ключом, а тестового инстанса нет.
    const result = await testDraft({
      start_node_id: "wait",
      event_payload_json: JSON.stringify({ urgent: true }),
    });

    assert.equal(Object.hasOwn(result, "instance_id"), false);
    assert.equal(Object.hasOwn(result, "journal"), false);
    assert.equal(Object.hasOwn(result, "state_changed_event"), false);
    assert.equal(Object.hasOwn(result, "workflow_version_id"), false);
  });

  it("трасса различает flow и data и несёт входы с выходами", async () => {
    const result = await testDraft({
      start_node_id: "wait",
      event_payload_json: JSON.stringify({ urgent: true }),
    });
    const byId = Object.fromEntries(result.trace.map((entry: any) => [entry.nodeId, entry]));

    assert.equal(byId.wait.via, "flow");
    // pick — pure-узел: в очередь exec не попадает, вычисляется по требованию branch.
    assert.equal(byId.pick.via, "data");
    assert.deepEqual(byId.pick.inputs, { data: { urgent: true } });
    assert.deepEqual(byId.pick.outputs, { value: true });
    assert.equal(typeof byId.wait.durationMs, "number");
  });

  it("падение — это результат с трассой, а не ошибка вызова", async () => {
    // Драфт валиден только по форме графа (решение A10), поэтому упасть на полпути
    // он вправе. Редактору нужна трасса до места обрыва, а не gRPC-ошибка.
    const schema = {
      schema_version: WORKFLOW_SCHEMA_VERSION,
      kind: "workflow",
      nodes: [
        node("wait", "wait-event", { event_type: "message.created" }),
        node("boom", "transform", { code: "throw new Error('взорвалось');", outputs: [{ name: "value", type: "string" }] }),
        node("w", "variable_write", { name: "v", inputs: [{ name: "value", type: "string" }] }),
      ],
      connections: [link("c1", "wait", "out", "w", "in"), link("c2", "boom", "value", "w", "value")],
    };

    const result = await testDraft({
      schema_json: JSON.stringify(schema),
      start_node_id: "wait",
      event_payload_json: JSON.stringify({}),
    });

    assert.equal(result.status, "failed");
    assert.equal(result.error.node_id, "boom");
    assert.match(result.error.message, /взорвалось/);

    const failed = result.trace.find((entry: any) => entry.failed);
    assert.equal(failed.nodeId, "boom");
    // Дошли до wait — это видно, и это главное, ради чего трасса и нужна.
    assert.equal(result.trace.some((entry: any) => entry.nodeId === "wait"), true);
  });

  it("требует start_node_id: точка входа схемы 2.0 — узел «Ожидание события»", async () => {
    await assert.rejects(() => testDraft({ start_node_id: "", event_payload_json: "{}" }), /start_node_id/);
  });
});
