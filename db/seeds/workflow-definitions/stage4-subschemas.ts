import {
  DEMO_ORGANIZATION_SEED,
  M0_SEED_TIMESTAMP,
} from "../../../packages/testing/src/db/m0-seed-data.js";

/**
 * Сидовые субсхемы демо-организации (Ревизия 2026-07-15, решение A4).
 *
 * Субсхема — переиспользуемый фрагмент, который вызывается узлом `sub_schema`.
 * В 2.0 у неё `kind: "subschema"` и ровно одна пара границ `start`/`end`: они
 * задают, что субсхема принимает и что отдаёт. Событий внутри нет — субсхему
 * запускает вызывающий граф, а не подписка.
 *
 * Прежняя версия оставалась на 1.0 (`entry`, `expression`, без `kind`) и была
 * неисполнима: без `kind` исполнитель принял бы её за схему верхнего уровня и
 * потребовал узел «Ожидание события».
 */
export const SEEDED_WORKFLOW_SUBSCHEMAS = Object.freeze([
  {
    id: "00000000-0000-4000-8000-000000000841",
    organization_id: DEMO_ORGANIZATION_SEED.id,
    slug: "support-common-context",
    name: "Общий контекст поддержки",
    status: "active",
    created_at: M0_SEED_TIMESTAMP,
    updated_at: M0_SEED_TIMESTAMP,
    schema: {
      schema_version: "2.0.0",
      kind: "subschema",
      nodes: [
        {
          id: "node-subschema-start",
          type: "start",
          label: "Вход: сообщение",
          config: {
            outputs: [{ id: "message", label: "Сообщение", type: "object" }],
          },
          position: { x: 40, y: 40 },
        },
        {
          id: "node-normalize-support-context",
          type: "transform",
          label: "Нормализовать общий контекст",
          config: {
            code: [
              "const message = input.message ?? {};",
              "return {",
              '  text: String(message.text ?? ""),',
              "  direction: message.direction,",
              "  conversationId: message.conversationId,",
              "  clientId: message.clientId,",
              '  subschema: "support-common-context",',
              "};",
            ].join("\n"),
            inputs: [{ name: "message", type: "object" }],
            outputs: [{ name: "context", type: "object", path: "result" }],
          },
          position: { x: 280, y: 200 },
        },
        {
          id: "node-subschema-end",
          type: "end",
          label: "Выход: контекст",
          config: {
            inputs: [{ id: "context", label: "Контекст", type: "object" }],
          },
          position: { x: 520, y: 40 },
        },
      ],
      connections: [
        {
          id: "conn-exec-start-end",
          from: "node-subschema-start",
          fromPort: "out",
          to: "node-subschema-end",
          toPort: "in",
        },
        {
          id: "conn-data-start-normalize",
          from: "node-subschema-start",
          fromPort: "message",
          to: "node-normalize-support-context",
          toPort: "message",
        },
        {
          id: "conn-data-normalize-end",
          from: "node-normalize-support-context",
          fromPort: "context",
          to: "node-subschema-end",
          toPort: "context",
        },
      ],
    },
  },
]);
