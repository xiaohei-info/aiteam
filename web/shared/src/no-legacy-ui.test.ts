import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sharedRoot = resolve(import.meta.dirname, "..");

describe("Shared zero-legacy UI gate", () => {
  it("does not retain the retired shared UI or black-gold token sources", () => {
    expect(existsSync(join(sharedRoot, "src/ui"))).toBe(false);
    expect(existsSync(join(sharedRoot, "src/design-system"))).toBe(false);
    expect(existsSync(join(sharedRoot, "scripts/build-tokens-css.mjs"))).toBe(false);
    expect(existsSync(join(sharedRoot, "dist/ui"))).toBe(false);
    expect(existsSync(join(sharedRoot, "dist/design-system"))).toBe(false);
  });

  it("does not export or depend on the retired compatibility stack", () => {
    const packageJson = readFileSync(join(sharedRoot, "package.json"), "utf8");
    const indexSource = readFileSync(join(sharedRoot, "src/index.ts"), "utf8");
    const forbidden = [
      '"./ui"',
      '"./design-system"',
      "tokens.css",
      "@radix-ui/react-slot",
      "tailwind-merge",
      '"clsx"',
      "build-tokens-css",
    ];

    expect(forbidden.filter((value) => packageJson.includes(value))).toEqual([]);
    expect(indexSource).not.toContain("./design-system/index.js");
  });
});
