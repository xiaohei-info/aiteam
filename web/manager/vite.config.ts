import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// 企业端前端 Vite 配置。dev 由各端独立启动；生产构建产物由 manager_service 同 origin 托管（08 §12.3 无中心 BFF）。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5174,
    // dev 时把 /api 代理到本端 manager_service（默认 :8000，按环境覆盖）。
    proxy: {
      "/api": {
        target: process.env.MANAGER_API_ORIGIN ?? "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
