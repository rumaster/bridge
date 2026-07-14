import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

const backendInternalUrl = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:3000";
// C7-realtime WS обслуживает ОТДЕЛЬНЫЙ app-сервер (services/edge-gateway
// c7-ws-main.ts), а не backend (NestJS не отдаёт WebSocket — /api/v1/ws → 404).
// Поэтому /api/v1/ws проксируем на WS-сервер, а остальной /api — на backend.
// Дефолт указывает на docker-DNS имя сервиса в compose (c7-ws:3000).
const c7WebSocketUrl = process.env.C7_WS_INTERNAL_URL ?? "http://localhost:3000";
const backendProxy = {
  // Более специфичный ключ /api/v1/ws должен идти ПЕРВЫМ: vite/http-proxy
  // сопоставляет префиксы по порядку, иначе широкий /api перехватил бы WS.
  "/api/v1/ws": {
    target: c7WebSocketUrl,
    changeOrigin: true,
    ws: true
  },
  "/api": {
    target: backendInternalUrl,
    changeOrigin: true
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
