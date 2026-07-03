import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";

import { resetMockBackendState } from "../src/api/mocks/handlers";
import { server } from "../src/api/mocks/node";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  resetMockBackendState();
  window.localStorage.clear();
});

afterAll(() => {
  server.close();
});
