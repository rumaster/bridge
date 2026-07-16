import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";

import { resetMockBackendState } from "../src/api/mocks/handlers";
import { server } from "../src/api/mocks/node";

configure({ asyncUtilTimeout: 5000 });

/**
 * ResizeObserver для холста схем (`@xyflow/react`): в jsdom его нет, а ReactFlow
 * измеряет им контейнер и без него падает при монтировании — вместе со всей
 * страницей `/workflow` и любым тестом, который её рендерит.
 *
 * Заглушка ничего не измеряет намеренно: размеры в jsdom всё равно нулевые, а
 * тестам нужен смонтированный холст, а не его геометрия. Проверка того, что узлы
 * реально раскладываются, — работа браузера, а не jsdom.
 */
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

// DOMMatrixReadOnly и matchMedia — из той же серии: ReactFlow трогает их при
// монтировании, jsdom их не реализует.
if (!("DOMMatrixReadOnly" in globalThis)) {
  globalThis.DOMMatrixReadOnly = class DOMMatrixReadOnlyStub {
    m22 = 1;
    constructor(_transform?: string) {}
  } as unknown as typeof DOMMatrixReadOnly;
}

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetMockBackendState();
  window.localStorage.clear();
});

afterAll(() => {
  server.close();
});
