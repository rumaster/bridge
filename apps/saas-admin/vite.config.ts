import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const backendInternalUrl = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  build: {
    // Ограничение размера сборки (ТЗ §21.7): стабильные vendor-чанки
    // выделяются отдельно от кода приложения для лучшего кэширования.
    chunkSizeWarningLimit: 220,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (id.includes("react-router") || id.includes("/history/")) {
            return "vendor-router";
          }
          if (id.includes("lucide-react")) {
            return "vendor-icons";
          }
          if (id.includes("/react-dom/") || id.includes("/react/") || id.includes("/scheduler/")) {
            return "vendor-react";
          }
          return undefined;
        }
      }
    }
  },
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
