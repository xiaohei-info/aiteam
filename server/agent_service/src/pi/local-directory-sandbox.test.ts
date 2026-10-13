import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalSandbox } from "./sandbox.js";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

test("native macOS Bash cannot read local source documents or host authorization state", async (t) => {
  if (process.platform !== "darwin") { t.skip("macOS native acceptance only"); return; }
  const base = await mkdtemp(join(homedir(), ".aiteam-local-knowledge-boundary-"));
  const workspace = join(base, "workspace");
  const source = join(base, "source.txt");
  const authorization = join(base, "host-state.json");
  try {
    await mkdir(workspace);
    await writeFile(source, "local-knowledge-unique-secret");
    await writeFile(authorization, "host-authorization-secret");
    await writeFile(join(workspace, "visible.txt"), "workspace-visible");
    const sandbox = new LocalSandbox();
    assert.equal(await sandbox.isAvailable(workspace), true, "real Seatbelt must be available");
    for (const mode of ["read-only", "workspace-write"] as const) {
      const operations = sandbox.operations(workspace, undefined, mode);
      let visible = "";
      assert.equal((await operations.bash.exec("/bin/cat visible.txt", workspace, { onData: (chunk) => { visible += chunk; } })).exitCode, 0);
      assert.equal(visible, "workspace-visible");
      for (const path of [source, authorization]) {
        let output = "";
        const result = await operations.bash.exec(`/bin/cat ${quote(path)}`, workspace, { onData: (chunk) => { output += chunk; } });
        assert.notEqual(result.exitCode, 0);
        assert.equal(output.includes("unique-secret"), false);
        assert.equal(output.includes("authorization-secret"), false);
        assert.throws(() => operations.read.readFile(path), /escapes/);
      }
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("restricted modes keep the supported system runtimes usable (python3, node)", async (t) => {
  if (process.platform !== "darwin") { t.skip("macOS native acceptance only"); return; }
  const workspace = await mkdtemp(join(homedir(), ".aiteam-local-knowledge-runtime-"));
  try {
    const sandbox = new LocalSandbox();
    const operations = sandbox.operations(workspace, undefined, "read-only");
    // /usr/bin/python3 resolves through xcrun into CommandLineTools or Xcode.app.
    if (existsSync("/usr/bin/python3")) {
      let pythonOutput = "";
      const python = await operations.bash.exec("/usr/bin/python3 -c 'print(\"python-ok\")'", workspace, { onData: (chunk) => { pythonOutput += chunk; } });
      assert.equal(python.exitCode, 0, `python3 must stay usable inside the read boundary: ${pythonOutput}`);
      assert.ok(pythonOutput.includes("python-ok"));
    }
    let nodeOutput = "";
    const node = await operations.bash.exec(`${quote(process.execPath)} -e 'console.log("node-ok")'`, workspace, { onData: (chunk) => { nodeOutput += chunk; } });
    assert.equal(node.exitCode, 0, `node must stay usable inside the read boundary: ${nodeOutput}`);
    assert.ok(nodeOutput.includes("node-ok"));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
