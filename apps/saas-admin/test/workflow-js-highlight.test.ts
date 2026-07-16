import { describe, expect, it } from "vitest";

import { renderHighlightedHtml, tokenizeJs } from "../src/presentation/workflow/js-highlight";

/**
 * Подсветка рисуется слоем <pre> под прозрачной <textarea>. Инвариант: склейка
 * токенов побайтно равна исходнику — иначе слои разъедутся и текст задвоится.
 * Проверяется именно он, а не «покрасил ли ключевое слово».
 */
describe("tokenizeJs: склейка токенов равна исходнику", () => {
  const samples = [
    "return input.value;",
    "// комментарий\nreturn 1;",
    "/* блок\n   на две строки */\nconst x = 'привет';",
    'const s = "экранированная \\" кавычка";',
    "const t = `шаблон ${input.name} строка`;",
    "if (a >= 1e3 && b !== 0xFF) { return null; }",
    "const re = a / b / c;",
    "",
    "\n\n",
    "const незакрытая = 'строка без конца",
    "const emoji = '🙂 ок';",
  ];

  for (const source of samples) {
    it(`восстанавливает: ${JSON.stringify(source.slice(0, 34))}`, () => {
      expect(tokenizeJs(source).map((token) => token.value).join("")).toBe(source);
    });
  }
});

describe("tokenizeJs: классификация", () => {
  it("различает ключевые слова, литералы, строки, числа и комментарии", () => {
    const kinds = Object.fromEntries(
      tokenizeJs("const x = true; // 42\nreturn 'a' + 1;").map((token) => [token.value.trim(), token.kind]),
    );

    expect(kinds.const).toBe("keyword");
    expect(kinds.true).toBe("literal");
    expect(kinds.return).toBe("keyword");
    expect(kinds["'a'"]).toBe("string");
    expect(kinds["1"]).toBe("number");
    expect(kinds["// 42"]).toBe("comment");
  });

  it("не путает ключевое слово с частью идентификатора", () => {
    // returnValue — не return: иначе подсветка красила бы половину слова.
    const tokens = tokenizeJs("returnValue");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe("plain");
  });

  it("незакрытая строка не съедает остаток и не теряет символы", () => {
    const source = "const a = 'ещё печатаю";
    expect(tokenizeJs(source).map((t) => t.value).join("")).toBe(source);
  });
});

describe("renderHighlightedHtml", () => {
  it("экранирует HTML: код может содержать теги", () => {
    const html = renderHighlightedHtml("return '<script>alert(1)</script>';");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("экранирует амперсанд и кавычки", () => {
    const html = renderHighlightedHtml('const a = b && c; const s = "x";');

    expect(html).toContain("&amp;&amp;");
    expect(html).toContain("&quot;");
  });

  it("дублирует хвостовой перевод строки, иначе <pre> схлопнет последнюю строку", () => {
    expect(renderHighlightedHtml("return 1;\n").endsWith("\n")).toBe(true);
  });
});
