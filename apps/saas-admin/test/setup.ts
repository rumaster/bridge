import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";

import { resetMockBackendState } from "../src/api/mocks/handlers";
import { server } from "../src/api/mocks/node";

configure({ asyncUtilTimeout: 5000 });

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
