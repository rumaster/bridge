export const DEFAULT_VISITOR_SESSION_STORAGE_KEY =
  "bridge.webChat.visitorSessionId";

type VisitorSessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function loadStoredVisitorSession(
  storage: VisitorSessionStorage | null = getBrowserStorage(),
): string | null {
  if (!storage) {
    return null;
  }

  try {
    const value = storage.getItem(DEFAULT_VISITOR_SESSION_STORAGE_KEY)?.trim();
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveStoredVisitorSession(
  visitorSessionId: string,
  storage: VisitorSessionStorage | null = getBrowserStorage(),
) {
  if (!storage) {
    return;
  }

  const normalized = visitorSessionId.trim();
  try {
    if (normalized.length === 0) {
      storage.removeItem(DEFAULT_VISITOR_SESSION_STORAGE_KEY);
      return;
    }

    storage.setItem(DEFAULT_VISITOR_SESSION_STORAGE_KEY, normalized);
  } catch {
    // Embedded widgets must keep working when storage is blocked by the host page.
  }
}

function getBrowserStorage(): VisitorSessionStorage | null {
  return globalThis.window?.localStorage ?? null;
}
