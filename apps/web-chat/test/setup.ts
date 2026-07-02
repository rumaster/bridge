import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { resetMockMessages } from "../src/mocks/handlers";
import { server } from "../src/mocks/server";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  resetMockMessages();
  document.body.innerHTML = "";
});

afterAll(() => {
  server.close();
});
