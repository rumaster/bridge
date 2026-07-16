/**
 * Подсветка JS для узла Transform — свои 100 строк вместо CodeMirror/Monaco.
 *
 * Зависимость на редактор кода здесь не окупается: подсвечивается короткое тело
 * функции, а не файл. Токенизатор нарочно грубый — он не парсит JS, а различает
 * комментарий, строку, число, ключевое слово и всё остальное.
 *
 * ИНВАРИАНТ, на котором держится вся конструкция: конкатенация `value` всех
 * токенов ПОБАЙТНО равна исходной строке. Подсветка рисуется слоем <pre> под
 * прозрачной <textarea>, и любой потерянный или добавленный символ сдвинет слои
 * друг относительно друга — текст начнёт двоиться.
 */

export type JsTokenKind = "comment" | "string" | "number" | "keyword" | "literal" | "plain";

export interface JsToken {
  kind: JsTokenKind;
  value: string;
}

const KEYWORDS = new Set([
  "await", "break", "case", "catch", "const", "continue", "default", "delete", "do", "else",
  "finally", "for", "function", "if", "in", "instanceof", "let", "new", "of", "return", "switch",
  "throw", "try", "typeof", "var", "void", "while", "yield",
]);

const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

export function tokenizeJs(source: string): JsToken[] {
  const tokens: JsToken[] = [];
  let index = 0;
  let plain = "";

  const flushPlain = (): void => {
    if (plain !== "") {
      tokens.push({ kind: "plain", value: plain });
      plain = "";
    }
  };
  const push = (kind: JsTokenKind, value: string): void => {
    flushPlain();
    tokens.push({ kind, value });
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      push("comment", source.slice(index, stop));
      index = stop;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      push("comment", source.slice(index, stop));
      index = stop;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      const end = readStringEnd(source, index, char);
      push("string", source.slice(index, end));
      index = end;
      continue;
    }

    if (DIGIT.test(char)) {
      let end = index;
      while (end < source.length && /[0-9._eExXa-fA-F]/.test(source[end])) end += 1;
      push("number", source.slice(index, end));
      index = end;
      continue;
    }

    if (IDENTIFIER_START.test(char)) {
      let end = index;
      while (end < source.length && IDENTIFIER_PART.test(source[end])) end += 1;
      const word = source.slice(index, end);
      if (KEYWORDS.has(word)) push("keyword", word);
      else if (LITERALS.has(word)) push("literal", word);
      else plain += word;
      index = end;
      continue;
    }

    plain += char;
    index += 1;
  }

  flushPlain();
  return tokens;
}

/** Незакрытая строка доходит до конца текста: пользователь ещё печатает. */
function readStringEnd(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * HTML подсветки для слоя <pre>. Хвостовой перевод строки дублируется: без него
 * <pre> схлопывает последнюю пустую строку, и слой становится короче textarea.
 */
export function renderHighlightedHtml(source: string): string {
  const html = tokenizeJs(source)
    .map((token) =>
      token.kind === "plain"
        ? escapeHtml(token.value)
        : `<span class="js-token js-token-${token.kind}">${escapeHtml(token.value)}</span>`,
    )
    .join("");

  return source.endsWith("\n") ? `${html}\n` : html;
}
