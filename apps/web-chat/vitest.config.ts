import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    restoreMocks: true,
    // e2e-сценарии CP-7 исполняются Playwright, а не Vitest.
    exclude: ["**/node_modules/**", "**/dist/**", "test/e2e/**"],
  },
});
