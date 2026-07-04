import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createVersionRegistry } from "../../src/versions/version-registry.mjs";
import { VersionImmutabilityError, WorkflowStoreError } from "../../src/core/errors.mjs";

const ORG_A = "org-a";
const ORG_B = "org-b";
const fixedNow = () => "2026-07-04T00:00:00.000Z";

function schema(entry = "start") {
  return {
    schema_version: "1.0.0",
    workflow_id: "wf-1",
    entry,
    nodes: [{ id: entry, type: "transform", config: { expression: { op: "input" } } }],
    connections: [],
  };
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
    assert.equal(registry.getVersion({ organizationId: ORG_A, workflowId: "wf-1", versionId: v1.id }).schema.entry, "a");
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
    assert.equal(versions[0].schema.entry, "a");
  });

  it("опубликованная схема заморожена — мутация невозможна", () => {
    const registry = createVersionRegistry({ now: fixedNow });
    const v1 = registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: schema("a") });
    assert.throws(() => {
      v1.schema.entry = "hacked";
    }, TypeError);
    assert.throws(() => {
      v1.schema.nodes.push({ id: "x" });
    }, TypeError);
  });

  it("отклоняет схему, не прошедшую валидацию на этапе сохранения", () => {
    const registry = createVersionRegistry({ now: fixedNow });
    assert.throws(
      () => registry.publishVersion({ organizationId: ORG_A, workflowId: "wf-1", schema: { schema_version: "9.9" } }),
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
});
