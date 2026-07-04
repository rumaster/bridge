import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Bridge Web Chat M5 style isolation", () => {
  it("не публикует широкие глобальные селекторы во встраиваемую страницу", () => {
    const css = readFileSync(resolve(__dirname, "../src/style.css"), "utf8");

    expect(css).not.toMatch(/(^|\n)\s*:root\s*\{/);
    expect(css).not.toMatch(/(^|\n)\s*body\s*\{/);
    expect(css).not.toMatch(/(^|\n)\s*button,\s*\n\s*textarea\s*\{/);
    expect(css).toMatch(/\.bridge-chat-shell\s+button,/);
    expect(css).toMatch(/#bridge-web-chat-root/);
  });
});
