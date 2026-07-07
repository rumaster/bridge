import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

const backendInternalUrl = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:3000";
const backendProxy = {
  "/api": {
    target: backendInternalUrl,
    changeOrigin: true,
    ws: true
  }
};

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: backendProxy
  },
  preview: {
    proxy: backendProxy
  },
  test: {
    css: true,
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "test/e2e/**"],
    globals: true,
    setupFiles: ["./test/setup.ts"]
  }
});
