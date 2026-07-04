import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderTemplate } from "../../src/campaign/index.mjs";

describe("SVC-BCAST M4 — рендер шаблона кампании (ТЗ §14.5)", () => {
  it("подставляет значения по dot-пути из контекста получателя", () => {
    const result = renderTemplate(
      { type: "text", body: "Здравствуйте, {{ client.name }}! Заказ {{ order.id }}." },
      { client: { name: "Мария" }, order: { id: "A-17" } },
    );

    assert.equal(result.text, "Здравствуйте, Мария! Заказ A-17.");
    assert.deepEqual(result.used, ["client.name", "order.id"]);
    assert.deepEqual(result.missing, []);
  });

  it("детерминирован: один и тот же (шаблон, контекст) даёт один и тот же текст", () => {
    const template = { type: "text", body: "Привет, {{client.name}}" };
    const context = { client: { name: "Иван" } };

    assert.equal(
      renderTemplate(template, context).text,
      renderTemplate(template, context).text,
    );
  });

  it("неизвестные плейсхолдеры заменяются пустой строкой и попадают в missing", () => {
    const result = renderTemplate(
      { type: "text", body: "Привет, {{client.name}}!" },
      {},
    );

    assert.equal(result.text, "Привет, !");
    assert.deepEqual(result.missing, ["client.name"]);
    assert.deepEqual(result.used, []);
  });

  it("бросает на некорректном теле шаблона", () => {
    assert.throws(() => renderTemplate({ type: "text" }, {}), /template\.body/);
  });
});
