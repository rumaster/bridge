/**
 * Разбор параметров хостируемой страницы организации Web Chat (W5, WG-1/WG-2,
 * docs/plan/web-chat-channel-production.md). Организация берётся из URL —
 * `/chat/<organizationId>` (path) или `?organization_id=` / `?org=` (query), — а
 * не из хардкода. Чистая функция: тестируется без DOM.
 */
export interface WebChatPageParams {
  organizationId?: string;
  conversationId?: string;
}

export interface LocationLike {
  pathname?: string;
  search?: string;
}

export function resolveWebChatPageParams(location: LocationLike): WebChatPageParams {
  const organizationId =
    organizationIdFromPath(location.pathname) ??
    paramFromSearch(location.search, ["organization_id", "org"]);
  const conversationId = paramFromSearch(location.search, ["conversation_id", "conversation"]);

  return {
    ...(organizationId ? { organizationId } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

/** Достаёт `<organizationId>` из пути `/chat/<organizationId>` (в т.ч. вложенного). */
function organizationIdFromPath(pathname: string | undefined): string | undefined {
  if (!pathname) {
    return undefined;
  }
  const match = pathname.match(/\/chat\/([^/?#]+)/);
  const raw = match?.[1];
  if (!raw) {
    return undefined;
  }
  const value = safeDecode(raw).trim();
  return value.length > 0 ? value : undefined;
}

function paramFromSearch(search: string | undefined, keys: string[]): string | undefined {
  if (!search) {
    return undefined;
  }
  const params = new URLSearchParams(search);
  for (const key of keys) {
    const value = params.get(key)?.trim();
    if (value && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
