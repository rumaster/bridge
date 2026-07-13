import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEdgeAttachmentGc } from "../../src/edge-attachment-gc.js";
import type { AttachmentSweepOptions, AttachmentSweepResult } from "../../src/edge-attachment-store.js";

const silentLogger = { info() {}, warn() {}, error() {} };

function fakeStore(sweepImpl: (options: AttachmentSweepOptions) => Promise<AttachmentSweepResult>) {
  const calls: AttachmentSweepOptions[] = [];
  return {
    calls,
    store: {
      async sweep(options: AttachmentSweepOptions): Promise<AttachmentSweepResult> {
        calls.push(options);
        return sweepImpl(options);
      },
    },
  };
}

const emptyResult: AttachmentSweepResult = {
  scanned: 0,
  deleted: 0,
  kept: 0,
  reclaimedBytes: 0,
  errors: 0,
};

describe("edge attachment GC scheduler", () => {
  it("rejects non-positive TTL (GC only wired when TTL configured)", () => {
    const { store } = fakeStore(async () => emptyResult);
    assert.throws(() => createEdgeAttachmentGc({ store, ttlMs: 0, logger: silentLogger }), /ttlMs/);
    assert.throws(() => createEdgeAttachmentGc({ store, ttlMs: -5, logger: silentLogger }), /ttlMs/);
  });

  it("forwards ttlMs, now, and isLive to the store sweep", async () => {
    const isLive = (ref: string) => ref === "keep";
    const { store, calls } = fakeStore(async () => emptyResult);
    const gc = createEdgeAttachmentGc({
      store,
      ttlMs: 1234,
      isLive,
      now: () => 5_000,
      logger: silentLogger,
    });

    await gc.sweepOnce();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].ttlMs, 1234);
    assert.equal(calls[0].now, 5_000);
    assert.equal(calls[0].isLive, isLive);
  });

  it("accumulates metrics across sweeps and records the last run", async () => {
    let call = 0;
    const results: AttachmentSweepResult[] = [
      { scanned: 5, deleted: 2, kept: 1, reclaimedBytes: 400, errors: 0 },
      { scanned: 3, deleted: 1, kept: 0, reclaimedBytes: 100, errors: 1 },
    ];
    const { store } = fakeStore(async () => results[call++]);
    const gc = createEdgeAttachmentGc({ store, ttlMs: 1000, logger: silentLogger });

    await gc.sweepOnce();
    await gc.sweepOnce();

    assert.deepEqual(gc.getMetrics(), {
      sweeps_total: 2,
      sweep_failures_total: 0,
      scanned_total: 8,
      deleted_total: 3,
      kept_total: 1,
      reclaimed_bytes_total: 500,
      delete_errors_total: 1,
      last_deleted: 1,
      last_reclaimed_bytes: 100,
    });
  });

  it("counts a thrown sweep as a failure without crashing", async () => {
    const { store } = fakeStore(async () => {
      throw new Error("volume offline");
    });
    const gc = createEdgeAttachmentGc({ store, ttlMs: 1000, logger: silentLogger });

    const result = await gc.sweepOnce();

    assert.equal(result, undefined);
    assert.equal(gc.getMetrics().sweep_failures_total, 1);
    assert.equal(gc.getMetrics().sweeps_total, 0);
  });

  it("does not overlap sweeps (inflight guard skips concurrent ticks)", async () => {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, calls } = fakeStore(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return emptyResult;
    });
    const gc = createEdgeAttachmentGc({ store, ttlMs: 1000, logger: silentLogger });

    const first = gc.sweepOnce();
    const second = gc.sweepOnce(); // должен пропуститься — предыдущий ещё идёт
    release();
    await Promise.all([first, second]);

    assert.equal(calls.length, 1);
    assert.equal(maxActive, 1);
  });
});
