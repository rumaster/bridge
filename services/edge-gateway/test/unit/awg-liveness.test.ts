import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createLivenessLink,
  interpretHandshakeFreshness,
} from "../../src/awg-liveness.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("awg-liveness — контроль «жив ли туннель» (Этап 2, §5.4)", () => {
  describe("interpretHandshakeFreshness — свежесть хендшейка → up/down", () => {
    const nowMs = Date.parse("2026-07-12T10:00:00.000Z");
    const maxAgeMs = 75_000; // ~3×keepalive(25с)

    it("нет хендшейка (0/undefined) → туннель down", () => {
      assert.deepEqual(interpretHandshakeFreshness({ latestHandshakeEpochSec: 0, nowMs, maxAgeMs }), {
        up: false,
        ageMs: null,
      });
      assert.deepEqual(
        interpretHandshakeFreshness({ latestHandshakeEpochSec: undefined, nowMs, maxAgeMs }),
        { up: false, ageMs: null },
      );
    });

    it("свежий хендшейк (возраст ≤ maxAge) → up", () => {
      const ts = nowMs / 1000 - 20; // 20с назад
      const r = interpretHandshakeFreshness({ latestHandshakeEpochSec: ts, nowMs, maxAgeMs });
      assert.equal(r.up, true);
      assert.equal(r.ageMs, 20_000);
    });

    it("устаревший хендшейк (возраст > maxAge) → down", () => {
      const ts = nowMs / 1000 - 200; // 200с назад
      const r = interpretHandshakeFreshness({ latestHandshakeEpochSec: ts, nowMs, maxAgeMs });
      assert.equal(r.up, false);
      assert.equal(r.ageMs, 200_000);
    });

    it("хендшейк из будущего (рассинхрон часов) → down", () => {
      const ts = nowMs / 1000 + 60;
      assert.equal(
        interpretHandshakeFreshness({ latestHandshakeEpochSec: ts, nowMs, maxAgeMs }).up,
        false,
      );
    });
  });

  describe("createLivenessLink — проба питает link (буферизация ↔ дренаж)", () => {
    it("флипает up↔down по результату пробы и зовёт onChange", async () => {
      let captured: (() => void) | undefined;
      let probeResult = true;
      const changes: boolean[] = [];
      const link = createLivenessLink({
        probe: async () => probeResult,
        onChange: (up) => changes.push(up),
        initialUp: true,
        setIntervalImpl: ((fn: () => void) => {
          captured = fn;
          return 1 as any;
        }) as any,
        clearIntervalImpl: (() => {}) as any,
      });

      link.start();
      await flush();
      assert.equal(link.isUp(), true, "проба true — остаётся up");
      assert.deepEqual(changes, []);

      probeResult = false;
      captured!();
      await flush();
      assert.equal(link.isUp(), false, "проба false — туннель down");
      assert.deepEqual(changes, [false]);

      probeResult = true;
      captured!();
      await flush();
      assert.equal(link.isUp(), true, "проба снова true — up");
      assert.deepEqual(changes, [false, true]);
    });

    it("отказ пробы (throw) трактуется как down", async () => {
      let captured: (() => void) | undefined;
      const link = createLivenessLink({
        probe: async () => {
          throw new Error("connect refused");
        },
        initialUp: true,
        setIntervalImpl: ((fn: () => void) => {
          captured = fn;
          return 1 as any;
        }) as any,
        clearIntervalImpl: (() => {}) as any,
      });
      link.start();
      await flush();
      assert.equal(link.isUp(), false);
      captured!(); // stop-safe повторный тик
      await flush();
      link.stop();
    });

    it("cut()/restore() ручной override", () => {
      const link = createLivenessLink({
        probe: async () => true,
        initialUp: true,
        setIntervalImpl: (() => 1 as any) as any,
        clearIntervalImpl: (() => {}) as any,
      });
      assert.equal(link.isUp(), true);
      link.cut();
      assert.equal(link.isUp(), false);
      link.restore();
      assert.equal(link.isUp(), true);
    });
  });
});
