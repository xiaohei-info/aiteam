import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const managerRoot = resolve(import.meta.dirname, "../..");
const sourceRoot = join(managerRoot, "src");
const currentFile = resolve(import.meta.filename);

const forbiddenSourcePatterns = [
  /@aiteam\/shared\/ui/,
  /(?:^|[^a-z])glass(?:[^a-z]|$)/i,
  /text-gold/,
  /bg-surface/,
  /border-gold/,
  /text-text-/,
  /rounded-window/,
  /className\s*=\s*["'`]/,
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (![".ts", ".tsx", ".css"].includes(extname(path))) return [];
    if (resolve(path) === currentFile) return [];
    return [path];
  });
}

describe("Manager zero-legacy UI gate", () => {
  it("does not contain legacy UI imports or Tailwind utility strings", () => {
    const violations = sourceFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return forbiddenSourcePatterns
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${relative(managerRoot, path)}: ${pattern.source}`);
    });

    expect(violations).toEqual([]);
  });

  it("does not retain the Tailwind build chain or shared legacy tokens", () => {
    const files = ["package.json", "vite.config.ts", "src/styles/app.css"];
    const forbiddenConfigPatterns = [
      /tailwindcss/,
      /@tailwindcss\/vite/,
      /@source/,
      /@aiteam\/shared\/design-system\/tokens\.css/,
    ];
    const violations = files.flatMap((file) => {
      const source = readFileSync(join(managerRoot, file), "utf8");
      return forbiddenConfigPatterns
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${file}: ${pattern.source}`);
    });

    expect(violations).toEqual([]);
  });
});
