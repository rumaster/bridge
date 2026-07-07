import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
