import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";

import { server } from "../src/api/mocks/node";
import { resetMockManagerWorkspaceBackend } from "../src/api/mocks/handlers";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  resetMockManagerWorkspaceBackend();
});

afterAll(() => {
  server.close();
});
