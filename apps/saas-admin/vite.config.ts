import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const backendInternalUrl = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  preview: {
    proxy: {
      "/api": {
        target: backendInternalUrl,
        changeOrigin: true
      }
    }
  },
  test: {
    css: true,
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
    restoreMocks: true,
    testTimeout: 10000
  }
});
