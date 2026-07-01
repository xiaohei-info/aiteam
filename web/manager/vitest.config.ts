import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

// 测试环境用 jsdom（react 组件 + DOM）；shared 的纯逻辑测试仍在 node 环境。
//
// shared 包 dist 由 `pnpm -r build` 顺序产出；本仓测试常以源码直连运行，避免构建耦合：
// 当 shared/dist 尚未生成时，将 @aiteam/shared 解析到其源码入口。
const sharedSrc = resolve(dirname(fileURLToPath(import.meta.url)), "../shared/src");
const sharedAlias = existsSync(resolve(sharedSrc, "dist/index.js"))
  ? null
  : [
      { find: /^@aiteam\/shared\/ui$/, replacement: resolve(sharedSrc, "ui/index.ts") },
      { find: "@aiteam/shared", replacement: resolve(sharedSrc, "index.ts") },
    ];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      ...(sharedAlias ?? []),
    ],
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
