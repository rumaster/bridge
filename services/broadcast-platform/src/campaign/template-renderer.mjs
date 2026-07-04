/**
 * Рендер шаблона кампании и персонализация (ТЗ §14.5).
 *
 * SVC-BCAST рендерит текст сообщения по данным клиента/организации **до**
 * передачи в ядро (C1): плейсхолдеры вида `{{client.name}}` заменяются
 * значениями из контекста получателя по dot-пути. Рендер детерминирован —
 * один и тот же (шаблон, контекст) всегда даёт один и тот же текст, что
 * необходимо для идемпотентной генерации сообщений (ТЗ §11.12).
 *
 * Неизвестные плейсхолдеры не роняют рассылку: они заменяются пустой строкой,
 * а их список возвращается в `missing` для диагностики (сегмент мог устареть,
 * см. риски плана §8).
 */

const PLACEHOLDER_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * @param {{ body: string, variables?: string[] }} template Шаблон C8 (`type=text`).
 * @param {Record<string, unknown>} [context] Данные получателя/организации.
 * @returns {{ text: string, used: string[], missing: string[] }}
 */
export function renderTemplate(template, context = {}) {
  if (!template || typeof template !== "object") {
    throw new TypeError("template must be an object");
  }
  if (typeof template.body !== "string") {
    throw new TypeError("template.body must be a string");
  }

  const used = [];
  const missing = [];

  const text = template.body.replace(PLACEHOLDER_PATTERN, (_match, path) => {
    const value = resolvePath(context, path);
    if (value === undefined || value === null) {
      missing.push(path);
      return "";
    }
    used.push(path);
    return String(value);
  });

  return { text, used, missing };
}

function resolvePath(context, path) {
  return path.split(".").reduce((accumulator, key) => {
    if (accumulator === undefined || accumulator === null) {
      return undefined;
    }
    if (typeof accumulator !== "object") {
      return undefined;
    }
    return accumulator[key];
  }, context);
}
