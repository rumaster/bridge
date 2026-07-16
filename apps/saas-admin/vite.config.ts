import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

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
    proxy: backendProxy
  },
  test: {
    css: true,
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
    restoreMocks: true,
    testTimeout: 10000,
    // Файлы гоняются последовательно, а не параллельно.
    //
    // `@xyflow/react` (холст редактора схем) — тяжёлая зависимость. При
    // параллельном прогоне воркеры компилируют и монтируют её одновременно,
    // голодают по CPU и упираются в таймаут — при том что каждый тест изолированно
    // проходит за доли секунды (проверено: любая падавшая группа последовательно
    // даёт 100%). Поднятие таймаута не помогает: дело не в медленной логике, а в
    // контеншене, и его величина скачет с нагрузкой машины. Последовательный
    // прогон делает результат детерминированным и не зависящим от числа ядер;
    // холст при этом компилируется один раз на процесс. Прод не затронут — там
    // страница грузится лениво (см. shell-тест про lazy skeleton).
    fileParallelism: false
  }
});
