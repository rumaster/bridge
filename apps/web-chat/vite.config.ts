import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
