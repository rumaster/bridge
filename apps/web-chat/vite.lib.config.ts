import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Конфиг встраиваемого ESM-бандла Web Chat (lib-режим): `src/embed.ts` →
 * `dist/bridge-web-chat.js` (ленивый loader с dynamic import). Отдельно от
 * страницы организации (`vite.config.ts`), чтобы бюджет бандла
 * (`scripts/check-bundle-size.ts`) считался только по `dist`, без ассетов страницы.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, "src/embed.ts"),
      formats: ["es"],
      fileName: () => "bridge-web-chat.js",
    },
    cssCodeSplit: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        chunkFileNames: "bridge-web-chat-[name]-[hash].js",
        assetFileNames: "bridge-web-chat-[name]-[hash][extname]",
      },
    },
  },
});
