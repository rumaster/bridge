import { createTenantBackendApiMock } from "../services/fbp-engine/src/backend/client.js";
import { createFbpRuntime } from "../services/fbp-engine/src/engine.js";

const now = () => "2026-07-04T00:00:00.000Z";
const ORG = "org-a";

const schemaV1 = {
  schema_version: "1.0.0",
  workflow_id: "wf-1",
  entry: "wait",
  nodes: [
    { id: "wait", type: "wait-event", config: { event_type: "approved" } },
    {
      id: "persist",
      type: "backend-api",
      input: { decision: { kind: "node", node: "wait", path: ["decision"] } },
      config: { method: "POST", path: "/api/v1/decisions", body: { op: "input" } },
    },
  ],
  connections: [{ from: "wait", to: "persist" }],
};

const mock = createTenantBackendApiMock({ now });
const runtime = createFbpRuntime({ backendClient: mock, now });

const v1 = runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: schemaV1 });
console.log("published v1:", v1.version_no, v1.id);

// Старт → должен уйти в ожидание
const started = await runtime.start({
  organizationId: ORG,
  workflowId: "wf-1",
  context: { organization_id: ORG, actor_user_id: "u1", trigger: "manual" },
  input: {},
});
console.log("started status:", started.status, "version_no:", started.version_no);
console.log("instance:", started.instance_id);

// Публикуем НОВУЮ версию (v2) — не должна влиять на идущий экземпляр
const v2 = runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: { ...schemaV1 } });
runtime.setDefaultVersion({ organizationId: ORG, workflowId: "wf-1", versionId: v2.id });
console.log("published v2, default switched to:", v2.version_no);

// Продолжаем на ДРУГОМ узле-исполнителе (тот же store)
const nodeB = createFbpRuntime({
  backendClient: mock,
  versions: runtime.versions,
  instances: runtime.instances,
  now,
});
const resumed = await nodeB.resume({
  organizationId: ORG,
  instanceId: started.instance_id,
  event: { decision: "approve" },
});
console.log("resumed status:", resumed.status, "on version_no:", resumed.version_no);
console.log("output:", JSON.stringify(resumed.output?.body?.echo));
console.log("journal events:", resumed.journal.map((e) => e.event).join(", "));

// Проверка неизменяемости: перезапись существующей версии
try {
  runtime.publishVersion({ organizationId: ORG, workflowId: "wf-1", schema: schemaV1, versionNo: 1 });
  console.log("ERROR: overwrite not rejected");
} catch (e) {
  console.log("overwrite rejected:", e.name, e.reason);
}

// Проверка заморозки схемы версии
try {
  v1.schema.entry = "hacked";
  console.log("ERROR: schema mutated");
} catch (e) {
  console.log("schema frozen:", e.name);
}
