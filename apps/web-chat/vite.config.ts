import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Конфиг хостируемой страницы организации Web Chat (W5, app-режим SPA):
 * `index.html` → `main.tsx`, вывод в `dist-page`. `appType: 'spa'` (по умолчанию)
 * даёт history-fallback, поэтому `/chat/<organizationId>` отдаёт `index.html`.
 * Встраиваемый ESM-бандл собирается отдельно (`vite.lib.config.ts`).
 */
const backendInternalUrl = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:3000";
const backendProxy = {
  "/api": {
    target: backendInternalUrl,
    changeOrigin: true,
    ws: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: backendProxy,
  },
  preview: {
    proxy: backendProxy,
  },
  build: {
    outDir: "dist-page",
    sourcemap: true,
  },
});
