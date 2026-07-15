import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WORKFLOW_SCHEMA_VERSION } from "@bridge/contracts/c5-workflow";
import { createVersionRegistry } from "../../src/versions/version-registry.js";
import { VersionImmutabilityError, WorkflowStoreError } from "../../src/core/errors.js";

const ORG_A = "org-a";
const ORG_B = "org-b";
const fixedNow = () => "2026-07-04T00:00:00.000Z";

/**
 * Схема 2.0 с маркером в коде transform: по нему видно, какая именно версия лежит
 * в реестре. Прежние тесты различали версии по полю `entry` — его больше нет.
 */
function schema(marker = "a") {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    kind: "workflow",
    workflow_id: "wf-1",
    nodes: [
      { id: "evt", type: "wait-event", position: { x: 0, y: 0 }, config: { event_type: "message.created" } },
      {
        id: "mark",
        type: "transform",
        position: { x: 0, y: 0 },
        config: { code: `return ${JSON.stringify(marker)};`, outputs: [{ name: "value", type: "string" }] },
      },
      { id: "w", type: "variable_write", position: { x: 0, y: 0 }, config: { inputs: [{ name: "payload", type: "string" }] } },
    ],
    connections: [
      { id: "c1", from: "evt", fromPort: "out", to: "w", toPort: "in" },
      { id: "c2", from: "mark", fromPort: "value", to: "w", toPort: "payload" },
    ],
  };
}

/** Маркер версии, лежащей в реестре, — читается из замороженной схемы. */
function markerOf(version: any) {
  return version.schema.nodes.find((node: any) => node.id === "mark").config.code;
}

describe("Реестр версий: неизменяемость (ТЗ §13.10)", () => {
  it("публикация правки порождает НОВУЮ версию, а не перезапись", () => {
    const registry = createVersionRegistry({ now: fixedNow });
    const v1 = registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: schema("a") });
    const v2 = registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: schema("b") });

    assert.equal(v1.version_no, 1);
    assert.equal(v2.version_no, 2);
    assert.notEqual(v1.id, v2.id);
    assert.equal(registry.listVersions({ organizationId: ORG_A, workflowId: "wf-1" }).length, 2);
    // Прежняя версия по-прежнему доступна в исходном виде.
    assert.equal(
      markerOf(registry.getVersion({ organizationId: ORG_A, workflowId: "wf-1", versionId: v1.id })),
      'return "a";',
    );
  });

  it("отклоняет попытку перезаписать существующую версию (version_no)", () => {
    const registry = createVersionRegistry({ now: fixedNow });
    registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: schema("a") });

    assert.throws(
      () => registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: schema("b"), versionNo: 1 }),
      (error) => error instanceof VersionImmutabilityError && error.reason === "version_immutable",
    );
    // Версия 1 не изменилась.
    const versions = registry.listVersions({ organizationId: ORG_A, workflowId: "wf-1" });
    assert.equal(versions.length, 1);
    assert.equal(markerOf(versions[0]), 'return "a";');
  });

  it("опубликованная схема заморожена — мутация невозможна", () => {
    const registry = createVersionRegistry({ now: fixedNow });
    const v1 = registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: schema("a") });
    assert.throws(() => {
      v1.schema.nodes[1].config.code = "return 'взломано';";
    }, TypeError);
    assert.throws(() => {
      v1.schema.nodes.push({ id: "x" });
    }, TypeError);
    assert.throws(() => {
      v1.schema.schema_version = "9.9.9";
    }, TypeError);
  });

  it("схема замораживается КОПИЕЙ — мутация исходника не протекает в реестр", () => {
    const registry = createVersionRegistry({ now: fixedNow });
    const source = schema("a");
    const v1 = registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: source });
    source.nodes[1].config.code = "return 'подменено после публикации';";
    assert.equal(markerOf(v1), 'return "a";');
  });

  it("отклоняет схему, не прошедшую валидацию на этапе сохранения", () => {
    const registry = createVersionRegistry({ now: fixedNow });
    assert.throws(
      () => registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: { schema_version: "9.9" } }),
      (error) => error instanceof WorkflowStoreError && error.reason === "invalid_schema",
    );
  });

  it("отклоняет схему прежней версии формата — 2.0 ломающий (решение A4)", () => {
    const registry = createVersionRegistry({ now: fixedNow });
    const outdated = schema("a");
    outdated.schema_version = "1.0.0";
    assert.throws(
      () => registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: outdated }),
      (error) => error instanceof WorkflowStoreError && error.reason === "invalid_schema",
    );
  });
});

describe("Реестр версий: версия по умолчанию — конфигурацией (ТЗ §13.10)", () => {
  it("первая версия становится по умолчанию; переключение влияет на resolveVersion", () => {
    const registry = createVersionRegistry({ now: fixedNow });
    const v1 = registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: schema("a") });
    const v2 = registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: schema("b") });

    assert.equal(registry.getDefaultVersion({ organizationId: ORG_A, workflowId: "wf-1" }).id, v1.id);
    assert.equal(registry.resolveVersion({ organizationId: ORG_A, workflowId: "wf-1" }).id, v1.id);

    registry.setDefaultVersion({ organizationId: ORG_A, workflowId: "wf-1", versionId: v2.id });
    assert.equal(registry.resolveVersion({ organizationId: ORG_A, workflowId: "wf-1" }).id, v2.id);
    // Явно заданная версия побеждает версию по умолчанию (для pinning).
    assert.equal(registry.resolveVersion({ organizationId: ORG_A, workflowId: "wf-1", versionId: v1.id }).id, v1.id);
  });

  it("бросает при отсутствии версий и при неизвестной версии", () => {
    const registry = createVersionRegistry({ now: fixedNow });
    assert.throws(
      () => registry.getDefaultVersion({ organizationId: ORG_A, workflowId: "wf-x" }),
      (error) => error instanceof WorkflowStoreError && error.reason === "version_not_found",
    );
    registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: schema("a") });
    assert.throws(
      () => registry.setDefaultVersion({ organizationId: ORG_A, workflowId: "wf-1", versionId: "нет-такой" }),
      (error) => error instanceof WorkflowStoreError && error.reason === "version_not_found",
    );
  });
});

describe("Реестр версий: изоляция арендаторов (§22.6)", () => {
  it("версии одного арендатора не видны другому", () => {
    const registry = createVersionRegistry({ now: fixedNow });
    const a1 = registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: schema("a") });
    registry.publishVersion({ organizationId: ORG_B, workflowId: "wf-1", schema: schema("b") });

    assert.equal(registry.listVersions({ organizationId: ORG_B, workflowId: "wf-1" }).length, 1);
    assert.throws(
      () => registry.getVersion({ organizationId: ORG_B, workflowId: "wf-1", versionId: a1.id }),
      (error) => error instanceof WorkflowStoreError && error.reason === "version_not_found",
    );
  });

  it("одноимённый workflow разных арендаторов ведёт независимую нумерацию версий", () => {
    const registry = createVersionRegistry({ now: fixedNow });
    registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: schema("a") });
    registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: schema("a2") });
    const b1 = registry.publishVersion({ organizationId: ORG_B, workflowId: "wf-1", schema: schema("b") });

    assert.equal(b1.version_no, 1, "нумерация арендатора B не наследует версии A");
    assert.equal(registry.listVersions({ organizationId: ORG_A, workflowId: "wf-1" }).length, 2);
  });
});
