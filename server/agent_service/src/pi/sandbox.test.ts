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

    const secretNames = [
      "HINDSIGHT_API_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY", "SERVICE_TOKEN", "SERVICE_SECRET", "SERVICE_APIKEY", "SERVICE_API_KEY",
      "TOKEN_BUDGET", "PROVIDER_MODE", "PRIVATE_KEY", "SSH_PRIVATE_KEY", "DATABASE_URL", "DB_URL",
      "DSN", "CONNECTION_STRING", "POSTGRES_URL", "SAFE_RUNTIME_VALUE",
    ] as const;
    const previousSecrets = secretNames.map((name) => [name, process.env[name]] as const);
    for (const name of secretNames) process.env[name] = name;
    try {
      let environment = "";
      const scrubbed = await operations.bash.exec(
        "printf '%s|' \"${HINDSIGHT_API_TOKEN-unset}\"; printf '%s|' \"${OPENAI_API_KEY-unset}\"; printf '%s|' \"${ANTHROPIC_API_KEY-unset}\"; printf '%s|' \"${AWS_ACCESS_KEY_ID-unset}\"; printf '%s|' \"${AWS_SECRET_ACCESS_KEY-unset}\"; printf '%s|' \"${SERVICE_TOKEN-unset}\"; printf '%s|' \"${SERVICE_SECRET-unset}\"; printf '%s|' \"${SERVICE_APIKEY-unset}\"; printf '%s|' \"${SERVICE_API_KEY-unset}\"; printf '%s|' \"${TOKEN_BUDGET-unset}\"; printf '%s|' \"${PROVIDER_MODE-unset}\"; printf '%s|' \"${PRIVATE_KEY-unset}\"; printf '%s|' \"${SSH_PRIVATE_KEY-unset}\"; printf '%s|' \"${DATABASE_URL-unset}\"; printf '%s|' \"${DB_URL-unset}\"; printf '%s|' \"${DSN-unset}\"; printf '%s|' \"${CONNECTION_STRING-unset}\"; printf '%s|' \"${POSTGRES_URL-unset}\"; printf '%s' \"${SAFE_RUNTIME_VALUE-unset}\"",
        workspace,
        { onData: (data) => { environment += data.toString(); } },
      );
      assert.equal(scrubbed.exitCode, 0);
      assert.equal(environment, "unset|unset|unset|unset|unset|unset|unset|unset|unset|TOKEN_BUDGET|PROVIDER_MODE|unset|unset|unset|unset|unset|unset|unset|SAFE_RUNTIME_VALUE");
    } finally {
      for (const [name, value] of previousSecrets) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

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
