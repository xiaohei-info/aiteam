import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      all: true,
      include: ["src/**"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/test-setup.ts", "src/**/*.d.ts"],
    },
  },
});
