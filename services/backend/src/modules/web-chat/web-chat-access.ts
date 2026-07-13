/**
 * Контроль доступа публичных Web Chat-ручек (W4, WG-10/WG-11,
 * docs/plan/web-chat-channel-production.md): allow-list Origin из config канала и
 * резолв источника (client IP) с учётом прокси/Edge. Чистые функции — тестируются
 * без БД.
 */

/** Контекст запроса для публичных ручек (браузерный Origin + источник). */
export interface WebChatRequestContext {
  origin?: string;
  clientIp?: string;
}

/**
 * Разрешённые origin из config канала: `widget_origin` (строка) и/или
 * `widget_origins` (массив строк). Нормализуются (нижний регистр, без хвостового
 * слэша).
 */
export function parseAllowedOrigins(config: Record<string, unknown> | null | undefined): string[] {
  if (!config) {
    return [];
  }
  const single = typeof config.widget_origin === "string" ? [config.widget_origin] : [];
  const many = Array.isArray(config.widget_origins)
    ? config.widget_origins.filter((value): value is string => typeof value === "string")
    : [];
  return [...single, ...many].map(normalizeOrigin).filter((value) => value.length > 0);
}

/**
 * Разрешён ли Origin запроса для канала. Если allow-list не задан — ограничение
 * выключено (разрешаем любой). Если задан — Origin обязан совпасть; отсутствие
 * Origin при заданном allow-list трактуется как запрет.
 */
export function isOriginAllowed(
  config: Record<string, unknown> | null | undefined,
  origin: string | undefined,
): boolean {
  const allowed = parseAllowedOrigins(config);
  if (allowed.length === 0) {
    return true;
  }
  if (!origin) {
    return false;
  }
  return allowed.includes(normalizeOrigin(origin));
}

/**
 * Резолвит источник запроса: первый хоп `X-Forwarded-For` (клиент за Edge/прокси)
 * или fallback IP соединения. Используется как ключ rate-limit.
 */
export function resolveClientIp(
  forwardedFor: string | undefined,
  fallbackIp: string | undefined,
): string {
  const firstHop = forwardedFor?.split(",")[0]?.trim();
  if (firstHop && firstHop.length > 0) {
    return firstHop;
  }
  return fallbackIp && fallbackIp.length > 0 ? fallbackIp : "unknown";
}

function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}
