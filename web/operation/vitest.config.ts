import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// 测试环境用 jsdom（react 组件 + DOM）；shared 的纯逻辑测试仍在 node 环境。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      all: true,
      include: ["src/**"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/test/**", "src/**/*.d.ts"],
    },
  },
});
