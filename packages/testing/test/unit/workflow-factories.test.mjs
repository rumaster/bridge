import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertMonotonicWorkflowVersionNumbers,
  createTestOutboxEvent,
  createTestWorkflow,
  createTestWorkflowExecutionLog,
  createTestWorkflowInstance,
  createTestWorkflowInstanceState,
  createTestWorkflowVersion,
  createTestWorkflowVersionSequence,
  isMonotonicWorkflowVersionNumbers,
} from "../../src/db/factories.mjs";

describe("workflow factories", () => {
  it("creates a draft workflow with matching timestamps", () => {
    const workflow = createTestWorkflow();
    assert.equal(workflow.status, "draft");
    assert.equal(workflow.default_version_id, null);
    assert.equal(workflow.created_at, workflow.updated_at);
  });

  it("rejects unknown workflow status", () => {
    assert.throws(() => createTestWorkflow({ status: "paused" }), /workflow.status must be/);
  });

  it("creates workflow versions with positive version_no and object schema", () => {
    const version = createTestWorkflowVersion({ version_no: 3 });
    assert.equal(version.version_no, 3);
    assert.deepEqual(version.schema, { nodes: [], edges: [] });
  });

  it("rejects non-object schema and non-positive version_no", () => {
    assert.throws(
      () => createTestWorkflowVersion({ schema: [] }),
      /workflow_version.schema must be a JSON object/,
    );
    assert.throws(
      () => createTestWorkflowVersion({ version_no: 0 }),
      /workflow_version.version_no must be a positive/,
    );
  });

  it("builds a monotonic version sequence sharing the same workflow", () => {
    const sequence = createTestWorkflowVersionSequence(3);
    assert.deepEqual(
      sequence.map((version) => version.version_no),
      [1, 2, 3],
    );
    const workflowIds = new Set(sequence.map((version) => version.workflow_id));
    assert.equal(workflowIds.size, 1);
    assert.equal(isMonotonicWorkflowVersionNumbers(sequence), true);
  });
});

describe("workflow version monotonicity validator", () => {
  it("accepts strictly increasing version numbers", () => {
    assert.equal(isMonotonicWorkflowVersionNumbers([1, 2, 3]), true);
    assert.equal(
      isMonotonicWorkflowVersionNumbers([{ version_no: 2 }, { version_no: 5 }]),
      true,
    );
  });

  it("rejects duplicated, decreasing, or empty sequences", () => {
    assert.equal(isMonotonicWorkflowVersionNumbers([1, 1, 2]), false);
    assert.equal(isMonotonicWorkflowVersionNumbers([3, 2]), false);
    assert.equal(isMonotonicWorkflowVersionNumbers([]), false);
    assert.throws(
      () => assertMonotonicWorkflowVersionNumbers([2, 2]),
      /must be strictly greater than the previous/,
    );
  });
});

describe("workflow instance factories", () => {
  it("creates a pending instance pinned to a version", () => {
    const instance = createTestWorkflowInstance();
    assert.equal(instance.status, "pending");
    assert.equal(instance.started_at, null);
    assert.equal(instance.finished_at, null);
  });

  it("accepts a finished instance with ordered timestamps", () => {
    const instance = createTestWorkflowInstance({
      status: "completed",
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:01:00.000Z",
    });
    assert.equal(instance.status, "completed");
  });

  it("rejects finished_at without started_at and out-of-order timestamps", () => {
    assert.throws(
      () =>
        createTestWorkflowInstance({
          finished_at: "2026-01-01T00:01:00.000Z",
        }),
      /requires workflow_instance.started_at/,
    );
    assert.throws(
      () =>
        createTestWorkflowInstance({
          started_at: "2026-01-01T00:02:00.000Z",
          finished_at: "2026-01-01T00:01:00.000Z",
        }),
      /finished_at must be greater than or equal to started_at/,
    );
  });

  it("creates instance state and execution logs with object payloads", () => {
    const state = createTestWorkflowInstanceState();
    assert.deepEqual(state.state, { cursor: 0 });

    const log = createTestWorkflowExecutionLog({ event: "node.finished" });
    assert.equal(log.event, "node.finished");
    assert.deepEqual(log.data, {});
  });

  it("rejects blank execution log event", () => {
    assert.throws(
      () => createTestWorkflowExecutionLog({ event: "  " }),
      /workflow_execution_log.event must be a non-blank/,
    );
  });
});

describe("outbox event factory", () => {
  it("creates a pending event without published_at", () => {
    const event = createTestOutboxEvent();
    assert.equal(event.status, "pending");
    assert.equal(event.published_at, null);
  });

  it("accepts a published event with a published_at timestamp", () => {
    const event = createTestOutboxEvent({
      status: "published",
      created_at: "2026-01-01T00:00:00.000Z",
      published_at: "2026-01-01T00:00:05.000Z",
    });
    assert.equal(event.status, "published");
  });

  it("enforces published_at consistency with status", () => {
    assert.throws(
      () => createTestOutboxEvent({ status: "published" }),
      /published_at is required when status is published/,
    );
    assert.throws(
      () =>
        createTestOutboxEvent({
          status: "pending",
          published_at: "2026-01-01T00:00:05.000Z",
        }),
      /published_at must be null unless status is published/,
    );
    assert.throws(
      () =>
        createTestOutboxEvent({
          status: "published",
          created_at: "2026-01-01T00:00:05.000Z",
          published_at: "2026-01-01T00:00:00.000Z",
        }),
      /published_at must be greater than or equal to created_at/,
    );
  });
});
