import {
  DEMO_ORGANIZATION_SEED,
  M0_SEED_TIMESTAMP,
  SEEDED_ADMIN_USER_SEED,
} from "../../../packages/testing/src/db/m0-seed-data.js";

const input = Object.freeze({ op: "input" });

function getInput(path: Array<number | string>) {
  return { op: "get", object: input, path };
}

function lit(value: unknown) {
  return { op: "lit", value };
}

export const SEEDED_WORKFLOW_DEFINITIONS = Object.freeze([
  {
    id: "00000000-0000-4000-8000-000000000801",
    organization_id: DEMO_ORGANIZATION_SEED.id,
    name: "Автоответчик обращений",
    status: "active",
    default_version_id: "00000000-0000-4000-8000-000000000811",
    created_at: M0_SEED_TIMESTAMP,
    updated_at: M0_SEED_TIMESTAMP,
    versions: [
      {
        id: "00000000-0000-4000-8000-000000000811",
        version_no: 1,
        created_by: SEEDED_ADMIN_USER_SEED.id,
        created_at: M0_SEED_TIMESTAMP,
        schema: {
          schema_version: "1.0.0",
          entry: "node-wait-event-incoming",
          nodes: [
            {
              id: "node-wait-event-incoming",
              type: "wait-event",
              label: "Входящее сообщение",
              input: {
                message: { kind: "params", path: ["message"] },
              },
              config: {
                event_type: "channel.message_received",
              },
              position: { x: 40, y: 40 },
            },
            {
              id: "node-knowledge-base-search",
              type: "knowledge-base-search",
              label: "Поиск в базе знаний",
              input: {
                messageText: {
                  kind: "node",
                  node: "node-wait-event-incoming",
                  path: ["message", "text"],
                },
              },
              config: {
                query: getInput(["messageText"]),
                top_k: 5,
              },
              position: { x: 280, y: 40 },
            },
            {
              id: "node-build-support-context",
              type: "transform",
              label: "Собрать контекст ответа",
              input: {
                kb: { kind: "node", node: "node-knowledge-base-search", path: [] },
                messageText: {
                  kind: "node",
                  node: "node-wait-event-incoming",
                  path: ["message", "text"],
                },
              },
              config: {
                expression: {
                  op: "merge",
                  args: [
                    input,
                    lit({
                      priority: "normal",
                      workflow_case: "support-autoresponder",
                    }),
                  ],
                },
              },
              position: { x: 520, y: 40 },
            },
            {
              id: "node-llm-draft-reply",
              type: "llm",
              label: "Черновик ответа",
              input: {
                context: { kind: "node", node: "node-build-support-context", path: [] },
                messageText: {
                  kind: "node",
                  node: "node-wait-event-incoming",
                  path: ["message", "text"],
                },
              },
              config: {
                prompt: {
                  op: "concat",
                  args: [
                    lit("Подготовь краткий вежливый ответ клиенту на сообщение: "),
                    getInput(["messageText"]),
                  ],
                },
                params: lit({ temperature: 0.2 }),
              },
              position: { x: 760, y: 40 },
            },
            {
              id: "node-create-ticket",
              type: "backend-api",
              label: "Создать тикет",
              input: {
                draftReply: { kind: "node", node: "node-llm-draft-reply", path: [] },
                messageText: {
                  kind: "node",
                  node: "node-wait-event-incoming",
                  path: ["message", "text"],
                },
              },
              config: {
                method: "POST",
                path: "/api/v1/tickets",
                body: {
                  op: "merge",
                  args: [
                    input,
                    lit({
                      source: "workflow",
                      workflow_case: "support-autoresponder",
                    }),
                  ],
                },
              },
              position: { x: 1000, y: 40 },
            },
          ],
          connections: [
            {
              from: "node-wait-event-incoming",
              fromPort: "out",
              to: "node-knowledge-base-search",
              toPort: "in",
            },
            {
              from: "node-knowledge-base-search",
              fromPort: "out",
              to: "node-build-support-context",
              toPort: "in",
            },
            {
              from: "node-build-support-context",
              fromPort: "out",
              to: "node-llm-draft-reply",
              toPort: "in",
            },
            {
              from: "node-llm-draft-reply",
              fromPort: "out",
              to: "node-create-ticket",
              toPort: "in",
            },
          ],
        },
      },
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000802",
    organization_id: DEMO_ORGANIZATION_SEED.id,
    name: "Квалификация лидов",
    status: "draft",
    default_version_id: "00000000-0000-4000-8000-000000000812",
    created_at: M0_SEED_TIMESTAMP,
    updated_at: M0_SEED_TIMESTAMP,
    versions: [
      {
        id: "00000000-0000-4000-8000-000000000812",
        version_no: 1,
        created_by: SEEDED_ADMIN_USER_SEED.id,
        created_at: M0_SEED_TIMESTAMP,
        schema: {
          schema_version: "1.0.0",
          entry: "node-wait-event-lead",
          nodes: [
            {
              id: "node-wait-event-lead",
              type: "wait-event",
              label: "Новый лид",
              input: {
                lead: { kind: "params", path: ["lead"] },
                message: { kind: "params", path: ["message"] },
              },
              config: {
                event_type: "lead.created",
              },
              position: { x: 40, y: 40 },
            },
            {
              id: "node-normalize-lead",
              type: "transform",
              label: "Нормализовать лид",
              input: {
                budget: { kind: "params", path: ["lead", "budget"] },
                messageText: {
                  kind: "node",
                  node: "node-wait-event-lead",
                  path: ["message", "text"],
                },
              },
              config: {
                expression: {
                  op: "merge",
                  args: [
                    input,
                    lit({
                      source: "workflow",
                      workflow_case: "lead-qualifier",
                    }),
                  ],
                },
              },
              position: { x: 280, y: 40 },
            },
            {
              id: "node-check-budget",
              type: "branch",
              label: "Оценка бюджета",
              input: {
                budget: { kind: "node", node: "node-normalize-lead", path: ["budget"] },
              },
              config: {
                condition: {
                  op: "gte",
                  args: [getInput(["budget"]), lit(1000)],
                },
              },
              position: { x: 520, y: 40 },
            },
            {
              id: "node-create-deal",
              type: "backend-api",
              label: "Создать сделку",
              input: {
                lead: { kind: "node", node: "node-normalize-lead", path: [] },
              },
              config: {
                method: "POST",
                path: "/api/v1/deals",
                body: input,
              },
              position: { x: 760, y: 40 },
            },
          ],
          connections: [
            {
              from: "node-wait-event-lead",
              fromPort: "out",
              to: "node-normalize-lead",
              toPort: "in",
            },
            {
              from: "node-normalize-lead",
              fromPort: "out",
              to: "node-check-budget",
              toPort: "in",
            },
            {
              from: "node-check-budget",
              fromPort: "true",
              to: "node-create-deal",
              toPort: "in",
            },
          ],
        },
      },
    ],
  },
]);
