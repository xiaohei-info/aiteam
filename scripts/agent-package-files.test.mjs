// node --test scripts/agent-package-files.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectFiles, tarArguments } from "./agent-package-files.mjs";

function fakePackage() {
  const parent = mkdtempSync(join(tmpdir(), "agent-package-files-"));
  const root = join(parent, "aiteam-agent-test");
  mkdirSync(join(root, "node_modules", "@scope"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "node_modules", "@scope", "index.js"), "export {};\n");
  symlinkSync("index.js", join(root, "node_modules", "@scope", "main.js"));
  // What Finder leaves behind when a folder of the package is open during the build.
  for (const folder of [root, join(root, "node_modules"), join(root, "node_modules", "@scope")]) writeFileSync(join(folder, ".DS_Store"), "finder");
  return { parent, root };
}

test("the manifest lists package files and links but no Finder metadata", () => {
  const { parent, root } = fakePackage();
  try {
    const sha = (text) => createHash("sha256").update(text).digest("hex");
    assert.deepEqual(collectFiles(root), [
      { path: "node_modules/@scope/index.js", size: 11, sha256: sha("export {};\n") },
      { path: "node_modules/@scope/main.js", symlink: "index.js" },
      { path: "package.json", size: 3, sha256: sha("{}\n") },
    ]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the archive leaves Finder metadata out", () => {
  const { parent, root } = fakePackage();
  try {
    const archive = join(parent, "package.tar.gz");
    execFileSync("tar", tarArguments(root, archive));
    const listed = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n").filter(Boolean);
    assert(listed.includes("aiteam-agent-test/package.json"), listed.join(", "));
    assert(listed.includes("aiteam-agent-test/node_modules/@scope/index.js"), listed.join(", "));
    assert.deepEqual(listed.filter((name) => name.includes(".DS_Store")), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
