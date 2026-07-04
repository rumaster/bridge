import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EdgeSequencerError, createEdgeSequencer } from "../../src/edge-sequencer.mjs";

const ENDPOINT_A = "42345678-1234-4234-8234-1234567890a1";
const ENDPOINT_B = "42345678-1234-4234-8234-1234567890b2";

describe("Edge sequencer (присвоение sequence_number на входе, CP-7 §7.10)", () => {
  it("назначает монотонный sequence_number начиная с 1 в рамках endpoint", () => {
    const sequencer = createEdgeSequencer();

    assert.equal(sequencer.assign(ENDPOINT_A), 1);
    assert.equal(sequencer.assign(ENDPOINT_A), 2);
    assert.equal(sequencer.assign(ENDPOINT_A), 3);
    assert.equal(sequencer.peek(ENDPOINT_A), 3);
  });

  it("ведёт независимые счётчики для разных endpoint (ключ партиционирования)", () => {
    const sequencer = createEdgeSequencer();

    assert.equal(sequencer.assign(ENDPOINT_A), 1);
    assert.equal(sequencer.assign(ENDPOINT_B), 1);
    assert.equal(sequencer.assign(ENDPOINT_A), 2);
    assert.equal(sequencer.assign(ENDPOINT_B), 2);
    assert.equal(sequencer.assign(ENDPOINT_B), 3);

    assert.equal(sequencer.peek(ENDPOINT_A), 2);
    assert.equal(sequencer.peek(ENDPOINT_B), 3);
  });

  it("peek не инкрементирует и равен 0 для неизвестного endpoint", () => {
    const sequencer = createEdgeSequencer();

    assert.equal(sequencer.peek(ENDPOINT_A), 0);
    assert.equal(sequencer.peek(ENDPOINT_A), 0);
    assert.equal(sequencer.assign(ENDPOINT_A), 1);
  });

  it("restore рехидратирует счётчик из persisted max после рестарта Edge", () => {
    const sequencer = createEdgeSequencer();

    sequencer.restore(ENDPOINT_A, 41);
    assert.equal(sequencer.peek(ENDPOINT_A), 41);
    assert.equal(sequencer.assign(ENDPOINT_A), 42);
  });

  it("инициализируется из snapshot и не понижает нумерацию при restore", () => {
    const sequencer = createEdgeSequencer({ initial: { [ENDPOINT_A]: 10 } });

    assert.equal(sequencer.assign(ENDPOINT_A), 11);

    sequencer.restore(ENDPOINT_A, 5); // устаревшее значение не откатывает счётчик
    assert.equal(sequencer.peek(ENDPOINT_A), 11);
    assert.equal(sequencer.assign(ENDPOINT_A), 12);

    assert.deepEqual(sequencer.snapshot(), { [ENDPOINT_A]: 12 });
  });

  it("требует непустой endpoint_id", () => {
    const sequencer = createEdgeSequencer();

    assert.throws(() => sequencer.assign(""), EdgeSequencerError);
    assert.throws(() => sequencer.assign(undefined), EdgeSequencerError);
    assert.throws(() => sequencer.peek(null), EdgeSequencerError);
  });

  it("отклоняет некорректный restore-параметр", () => {
    const sequencer = createEdgeSequencer();

    assert.throws(() => sequencer.restore(ENDPOINT_A, -1), EdgeSequencerError);
    assert.throws(() => sequencer.restore(ENDPOINT_A, 1.5), EdgeSequencerError);
  });
});
