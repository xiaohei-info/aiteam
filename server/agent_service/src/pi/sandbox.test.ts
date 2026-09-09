import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { LocalSandbox } from "./sandbox.js";

function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

async function requireAvailable(t: { skip: (message?: string) => void }, sandbox: LocalSandbox, workspace: string): Promise<boolean> {
  if (await sandbox.isAvailable(workspace)) return true;
  if (process.env.AITEAM_SANDBOX_REQUIRE_NATIVE === "true") assert.fail("native sandbox is unavailable on this host");
  t.skip("no functional local sandbox backend on this host");
  return false;
}

test("LocalSandbox confines a harmless command and denies writes outside its workspace", async (t) => {
  const workspace = await mkdtemp(join(process.cwd(), ".dsh-sandbox-test-"));
  const outside = join(process.env.HOME ?? process.cwd(), `.dsh-sandbox-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sandbox = new LocalSandbox();
  try {
    if (!(await requireAvailable(t, sandbox, workspace))) return;
    const operations = sandbox.operations(workspace, undefined, "workspace-write");
    let output = "";
    const harmless = await operations.bash.exec("printf confined", workspace, { onData: (data) => { output += data.toString(); } });
    assert.equal(harmless.exitCode, 0);
    assert.equal(output, "confined");

    const secretNames = [
      "HINDSIGHT_API_TOKEN", "HINDSIGHT_SERVICE_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY", "SERVICE_TOKEN", "SERVICE_SECRET", "SERVICE_APIKEY", "SERVICE_API_KEY",
      "TOKEN_BUDGET", "PROVIDER_URL", "PROVIDER_URI", "PROVIDER_MODE", "PRIVATE_KEY", "SSH_PRIVATE_KEY", "AITEAM_SKILL_SIGNING_CURRENT_PRIVATE_KEY", "DATABASE_URL", "DB_URL",
      "REDIS_PASSWORD", "DB_PASSWORD", "DATABASE_PASSWORD", "LIGHTRAG_DB_PASSWORD", "LIGHTRAG_INSTANCES", "LIGHTRAG_AUTH_ACCOUNTS", "LIGHTRAG_URL", "LIGHTRAG_WORKSPACE", "LIGHTRAG_ADMIN_PASSWORD", "HINDSIGHT_CP_ACCESS_KEY", "AUTH_ACCOUNTS", "TOKEN_SECRET", "DSN", "CONNECTION_STRING", "POSTGRES_URL", "OAUTH_GOOGLE_CLIENT_SECRET", "OAUTH_GITHUB_CLIENT_SECRET", "LOGIN_AUDIT_PEPPER", "SAFE_RUNTIME_VALUE",
    ] as const;
    const previousSecrets = secretNames.map((name) => [name, process.env[name]] as const);
    for (const name of secretNames) process.env[name] = name;
    try {
      let environment = "";
      const scrubbed = await operations.bash.exec(
        "printf '%s|' \"${HINDSIGHT_API_TOKEN-unset}\"; printf '%s|' \"${HINDSIGHT_SERVICE_TOKEN-unset}\"; printf '%s|' \"${OPENAI_API_KEY-unset}\"; printf '%s|' \"${ANTHROPIC_API_KEY-unset}\"; printf '%s|' \"${AWS_ACCESS_KEY_ID-unset}\"; printf '%s|' \"${AWS_SECRET_ACCESS_KEY-unset}\"; printf '%s|' \"${SERVICE_TOKEN-unset}\"; printf '%s|' \"${SERVICE_SECRET-unset}\"; printf '%s|' \"${SERVICE_APIKEY-unset}\"; printf '%s|' \"${SERVICE_API_KEY-unset}\"; printf '%s|' \"${TOKEN_BUDGET-unset}\"; printf '%s|' \"${PROVIDER_URL-unset}\"; printf '%s|' \"${PROVIDER_URI-unset}\"; printf '%s|' \"${PROVIDER_MODE-unset}\"; printf '%s|' \"${PRIVATE_KEY-unset}\"; printf '%s|' \"${SSH_PRIVATE_KEY-unset}\"; printf '%s|' \"${AITEAM_SKILL_SIGNING_CURRENT_PRIVATE_KEY-unset}\"; printf '%s|' \"${DATABASE_URL-unset}\"; printf '%s|' \"${DB_URL-unset}\"; printf '%s|' \"${REDIS_PASSWORD-unset}\"; printf '%s|' \"${DB_PASSWORD-unset}\"; printf '%s|' \"${DATABASE_PASSWORD-unset}\"; printf '%s|' \"${LIGHTRAG_DB_PASSWORD-unset}\"; printf '%s|' \"${LIGHTRAG_INSTANCES-unset}\"; printf '%s|' \"${LIGHTRAG_AUTH_ACCOUNTS-unset}\"; printf '%s|' \"${LIGHTRAG_URL-unset}\"; printf '%s|' \"${LIGHTRAG_WORKSPACE-unset}\"; printf '%s|' \"${LIGHTRAG_ADMIN_PASSWORD-unset}\"; printf '%s|' \"${HINDSIGHT_CP_ACCESS_KEY-unset}\"; printf '%s|' \"${AUTH_ACCOUNTS-unset}\"; printf '%s|' \"${TOKEN_SECRET-unset}\"; printf '%s|' \"${AITEAM_CONSOLE_CREDENTIALS_FILE-unset}\"; printf '%s|' \"${DSN-unset}\"; printf '%s|' \"${CONNECTION_STRING-unset}\"; printf '%s|' \"${POSTGRES_URL-unset}\"; printf '%s|' \"${OAUTH_GOOGLE_CLIENT_SECRET-unset}\"; printf '%s|' \"${OAUTH_GITHUB_CLIENT_SECRET-unset}\"; printf '%s|' \"${LOGIN_AUDIT_PEPPER-unset}\"; printf '%s' \"${SAFE_RUNTIME_VALUE-unset}\"",
        workspace,
        { onData: (data) => { environment += data.toString(); } },
      );
      assert.equal(scrubbed.exitCode, 0);
      assert.equal(environment, "unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|TOKEN_BUDGET|unset|unset|PROVIDER_MODE|unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|unset|SAFE_RUNTIME_VALUE");
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
    assert.throws(() => operations.read.readFile(outside), /escapes the session workspace/);
    assert.throws(() => operations.edit.readFile(outside), /escapes the session workspace/);

    const symlinkEscape = join(workspace, "escape-link");
    await symlink(process.env.HOME ?? process.cwd(), symlinkEscape);
    assert.throws(() => operations.write.writeFile(join(symlinkEscape, "must-stay-inside"), "nope"), /escapes the session workspace/);
    await rm(symlinkEscape, { force: true });
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("LocalSandbox removes control-plane endpoint and credential aliases", async (t) => {
  const workspace = await mkdtemp(join(process.cwd(), ".dsh-sandbox-control-plane-"));
  const sandbox = new LocalSandbox();
  try {
    if (!(await requireAvailable(t, sandbox, workspace))) return;
    const operations = sandbox.operations(workspace, undefined, "workspace-write");
    const names = [
      "AITEAM_HINDSIGHT_URL", "HINDSIGHT_URL", "HINDSIGHT_RECALL_PATH", "NEWAPI_ADMIN_PASSWORD",
      "OPERATION_PROVIDER_CREDENTIAL_KEY", "MANAGER_CREDENTIAL_KEY", "POSTGRES_SUPER_PASSWORD", "SERVICE_CLIENT_TIMEOUT_MS",
    ] as const;
    const previous = names.map((name) => [name, process.env[name]] as const);
    for (const name of names) process.env[name] = name;
    try {
      let output = "";
      const result = await operations.bash.exec(
        "printf '%s|' \"${AITEAM_HINDSIGHT_URL-unset}\"; printf '%s|' \"${HINDSIGHT_URL-unset}\"; printf '%s|' \"${HINDSIGHT_RECALL_PATH-unset}\"; printf '%s|' \"${NEWAPI_ADMIN_PASSWORD-unset}\"; printf '%s|' \"${OPERATION_PROVIDER_CREDENTIAL_KEY-unset}\"; printf '%s|' \"${MANAGER_CREDENTIAL_KEY-unset}\"; printf '%s|' \"${POSTGRES_SUPER_PASSWORD-unset}\"; printf '%s' \"${SERVICE_CLIENT_TIMEOUT_MS-unset}\"",
        workspace,
        { onData: (data) => { output += data.toString(); } },
      );
      assert.equal(result.exitCode, 0);
      assert.equal(output, "unset|unset|unset|unset|unset|unset|unset|unset");
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("LocalSandbox applies read-only, workspace-write, and full-access modes", async () => {
  const workspace = await mkdtemp(join(process.cwd(), ".dsh-sandbox-permissions-"));
  const outside = join(process.env.HOME ?? process.cwd(), `.dsh-sandbox-permission-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sandbox = new LocalSandbox();
  try {
    const readOnly = sandbox.operations(workspace);
    assert.throws(() => readOnly.write.writeFile(join(workspace, "blocked"), "nope"), /只读权限/);

    const workspaceWrite = sandbox.operations(workspace, undefined, "workspace-write");
    await workspaceWrite.write.writeFile(join(workspace, "allowed"), "ok");
    assert.equal((await readFile(join(workspace, "allowed"))).toString(), "ok");

    const full = sandbox.operations(workspace, undefined, "full-access");
    await full.write.writeFile(outside, "full");
    assert.equal((await readFile(outside)).toString(), "full");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("LocalSandbox denies network access and terminates the whole child process group", async (t) => {
  const workspace = await mkdtemp(join(process.cwd(), ".dsh-sandbox-test-"));
  const sandbox = new LocalSandbox();
  const server = createServer((_request, response) => response.end("must-not-be-reached"));
  try {
    if (!(await requireAvailable(t, sandbox, workspace))) return;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    assert(address && typeof address === "object");
    const operations = sandbox.operations(workspace);
    const network = await operations.bash.exec(
      `${shellQuote(process.execPath)} -e ${shellQuote(`const net = require('node:net'); const socket = net.createConnection({ host: '127.0.0.1', port: ${address.port} }); socket.once('connect', () => process.exit(42)); socket.once('error', () => process.exit(0)); setTimeout(() => process.exit(43), 1000);`)}`,
      workspace,
      { onData: () => undefined },
    );
    assert.equal(network.exitCode, 0, "a confined child must not connect to the host loopback listener");

    const controller = new AbortController();
    const pending = operations.bash.exec("sleep 30", workspace, { onData: () => undefined, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, /aborted/);
    await assert.rejects(operations.bash.exec("sleep 30", workspace, { onData: () => undefined, timeout: 0.05 }), /timeout:0.05/);
    await assert.rejects(operations.bash.exec("true", workspace, { onData: () => undefined, timeout: 0 }), /Invalid timeout/);
  } finally {
    if (server.listening) {
      server.close();
      await once(server, "close").catch(() => undefined);
    }
    await rm(workspace, { recursive: true, force: true });
  }
});
