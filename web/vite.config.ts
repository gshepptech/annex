import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 4301,
    proxy: { "/api": { target: "http://127.0.0.1:4300", changeOrigin: false } },
  },
});
