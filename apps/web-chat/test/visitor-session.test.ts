import { describe, expect, it } from "vitest";
import {
  loadStoredVisitorSession,
  saveStoredVisitorSession,
} from "../src/platform/visitorSession";

describe("Bridge Web Chat visitor session storage", () => {
  it("восстанавливает сохраненную анонимную сессию посетителя", () => {
    const storage = new MapStorage();

    saveStoredVisitorSession("visitor-session-1", storage);

    expect(loadStoredVisitorSession(storage)).toBe("visitor-session-1");
  });

  it("игнорирует пустое значение сессии", () => {
    const storage = new MapStorage();
    storage.setItem("bridge.webChat.visitorSessionId", "   ");

    expect(loadStoredVisitorSession(storage)).toBeNull();
  });
});

class MapStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
