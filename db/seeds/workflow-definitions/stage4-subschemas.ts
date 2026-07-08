import {
  DEMO_ORGANIZATION_SEED,
  M0_SEED_TIMESTAMP,
} from "../../../packages/testing/src/db/m0-seed-data.js";

const input = Object.freeze({ op: "input" });

function lit(value: unknown) {
  return { op: "lit", value };
}

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
      schema_version: "1.0.0",
      entry: "node-normalize-support-context",
      nodes: [
        {
          id: "node-normalize-support-context",
          type: "transform",
          label: "Нормализовать общий контекст",
          input: {
            payload: { kind: "params", path: [] },
          },
          config: {
            expression: {
              op: "merge",
              args: [
                input,
                lit({
                  subschema: "support-common-context",
                }),
              ],
            },
          },
          position: { x: 40, y: 40 },
        },
      ],
      connections: [],
    },
  },
]);
