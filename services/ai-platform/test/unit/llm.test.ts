import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDeterministicMockLlm,
  createUnavailableLlm,
  embedText,
  LLM_EMBEDDING_DIMENSIONS,
  LlmUnavailableError,
} from "../../src/llm.js";

function l2(left, right) {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

describe("deterministic mock LLM — embeddings", () => {
  const llm = createDeterministicMockLlm();

  it("produces a 1536-dimension vector", async () => {
    const embedding = await llm.embed("Как оформить возврат заказа?");
    assert.equal(embedding.length, LLM_EMBEDDING_DIMENSIONS);
    assert.ok(embedding.every((value) => Number.isFinite(value)));
  });

  it("is deterministic for identical input", async () => {
    const first = await llm.embed("доставка заказа");
    const second = await llm.embed("доставка заказа");
    assert.deepEqual(first, second);
  });

  it("places topically related texts closer than unrelated ones (L2)", async () => {
    const query = await llm.embed("Как оформить возврат заказа?");
    const aboutReturn = await llm.embed(
      "Для возврата заказа уточните номер заказа и причину возврата.",
    );
    const aboutDelivery = await llm.embed(
      "Доставка заказа занимает один рабочий день по городу.",
    );
    const aboutPayment = await llm.embed(
      "Оплата счёта проходит через банковский шлюз партнёра.",
    );

    assert.ok(
      l2(query, aboutReturn) < l2(query, aboutDelivery),
      "return chunk must be closer than delivery chunk",
    );
    assert.ok(
      l2(query, aboutReturn) < l2(query, aboutPayment),
      "return chunk must be closer than payment chunk",
    );
  });

  it("exposes embedText as a pure helper with the same result", async () => {
    const viaProvider = await llm.embed("тест");
    const viaHelper = embedText("тест");
    assert.deepEqual(viaProvider, viaHelper);
  });
});

describe("deterministic mock LLM — generation", () => {
  const llm = createDeterministicMockLlm();

  it("generates an answer with a citation per chunk", async () => {
    const result = await llm.generate({
      query: "возврат",
      chunks: [
        {
          chunk_id: "c1",
          document_id: "d1",
          title: "Возврат",
          content: "Возврат оформляется в течение 14 дней.",
          distance: 0.1,
        },
        {
          chunk_id: "c2",
          document_id: "d2",
          title: "Сроки",
          content: "Деньги возвращаются на карту за 3 дня.",
          distance: 0.4,
        },
      ],
    });

    assert.match(result.text, /\[1\]/);
    assert.match(result.text, /\[2\]/);
    assert.equal(result.citations.length, 2);
    assert.equal(result.citations[0].chunk_id, "c1");
    assert.ok(result.confidence > 0 && result.confidence <= 1);
  });

  it("returns a low-confidence answer with no citations when there are no chunks", async () => {
    const result = await llm.generate({ query: "возврат", chunks: [] });
    assert.equal(result.citations.length, 0);
    assert.ok(result.confidence <= 0.3);
  });

  it("ranks confidence higher when the closest chunk is nearer", async () => {
    const near = await llm.generate({
      query: "q",
      chunks: [{ chunk_id: "c1", document_id: "d1", content: "a", distance: 0.1 }],
    });
    const far = await llm.generate({
      query: "q",
      chunks: [{ chunk_id: "c1", document_id: "d1", content: "a", distance: 1.5 }],
    });
    assert.ok(near.confidence > far.confidence);
  });
});

describe("unavailable LLM provider", () => {
  it("rejects embed and generate for the degradation path", async () => {
    const llm = createUnavailableLlm({ reason: "timeout" });
    assert.equal(llm.available, false);
    await assert.rejects(() => llm.embed("x"), LlmUnavailableError);
    await assert.rejects(() => llm.generate({ query: "x", chunks: [] }), LlmUnavailableError);
  });
});
