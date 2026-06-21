import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 用户端前端（08 §12.2/§12.3）。同 origin 部署——dev server 经 proxy 打本端 agent_service。
// 生产由本端服务自托管静态资源（无中心 BFF / 无中心 Edge）。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // workspace 包 @aiteam/shared 经 pnpm 软链；构建依赖其 dist（pnpm -r build 顺序产出）。
  server: {
    port: 5180,
    proxy: {
      // 只代理本端 /api/agent/* 与 /api/auth/*（08 §12.2 各端只调本端 API，不跨端直调）。
      "/api/agent": { target: "http://localhost:8180", changeOrigin: true },
      "/api/auth": { target: "http://localhost:8180", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
