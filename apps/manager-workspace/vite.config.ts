import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

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
    exclude: [...configDefaults.exclude, "test/e2e/**"],
    globals: true,
    setupFiles: ["./test/setup.ts"]
  }
});
