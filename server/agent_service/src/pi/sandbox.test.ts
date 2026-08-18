import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { LocalSandbox } from "./sandbox.js";

function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

test("LocalSandbox confines a harmless command and denies writes outside its workspace", async (t) => {
  const workspace = await mkdtemp(join(process.cwd(), ".dsh-sandbox-test-"));
  const outside = join(process.env.HOME ?? process.cwd(), `.dsh-sandbox-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sandbox = new LocalSandbox();
  try {
    if (!(await sandbox.isAvailable(workspace))) {
      t.skip("no functional local sandbox backend on this host");
      return;
    }
    const operations = sandbox.operations(workspace);
    let output = "";
    const harmless = await operations.bash.exec("printf confined", workspace, { onData: (data) => { output += data.toString(); } });
    assert.equal(harmless.exitCode, 0);
    assert.equal(output, "confined");

    const denied = await operations.bash.exec(`printf denied > ${shellQuote(outside)}`, workspace, { onData: () => undefined });
    assert.notEqual(denied.exitCode, 0);
    await assert.rejects(stat(outside));
    await assert.rejects(readFile(outside));
    assert.throws(() => operations.write.writeFile(outside, "must stay in workspace"), /escapes the session workspace/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});
