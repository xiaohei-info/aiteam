import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
import { networkIsolatedArgv } from "./sandbox.js";

const config = { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 100 };
const policy = { mode: "workspace-write" as const, workspaceRoot: "/workspace" };

test("Linux selection probes bwrap before Landlock and returns a bwrap policy argv", () => {
  const provider = new LocalSandboxProvider(new Context(), config);
  provider.internals = { platform: "linux", probeBwrap: () => true, probeLandlock: () => "unusable" };
  const confined = provider.confine(["bash", "-c", "printf ok"], policy);
  assert.equal(confined.argv[0], "bwrap");
  assert.equal(confined.argv.at(-3), "bash");
  assert.equal(confined.argv.at(-1), "printf ok");
  assert.equal(confined.enforcement, "full");
});

test("Linux falls back to the functionally probed Landlock launcher", () => {
  const provider = new LocalSandboxProvider(new Context(), config);
  provider.internals = { platform: "linux", probeBwrap: () => false, landlockLauncher: "/opt/landlock-run", probeLandlock: () => "full" };
  const confined = provider.confine(["bash", "-c", "printf ok"], policy);
  assert.equal(confined.argv[0], "/opt/landlock-run");
  assert(confined.argv.includes("--rw"));
  assert(confined.argv.includes("/workspace"));
  assert.equal(confined.argv.at(-1), "printf ok");
});

test("macOS Seatbelt uses the same policy seam", () => {
  const provider = new LocalSandboxProvider(new Context(), config);
  provider.internals = { platform: "darwin", seatbeltExec: "/usr/bin/sandbox-exec", probeSeatbelt: () => true };
  const confined = provider.confine(["bash", "-c", "printf ok"], policy);
  assert.equal(confined.argv[0], "/usr/bin/sandbox-exec");
  assert.equal(confined.argv[1], "-p");
  assert(confined.argv[2]?.includes("/workspace"));
  assert.equal(confined.argv.at(-1), "printf ok");
});

test("Windows restricted-token runner uses the same policy seam", () => {
  const provider = new LocalSandboxProvider(new Context(), config);
  provider.internals = { platform: "win32", windowsAclRunnerArgs: ["node", "/fake/runner.js"], probeWindowsAcl: () => true };
  const confined = provider.confine(["bash", "-c", "printf ok"], { mode: "read-only", workspaceRoot: "C:\\workspace" });
  assert.deepEqual(confined.argv.slice(0, 2), ["node", "/fake/runner.js"]);
  assert(confined.argv.includes("--mode"));
  assert(confined.argv.includes("read-only"));
  assert.equal(confined.argv.at(-1), "printf ok");
});

test("unknown platforms fail closed instead of passing through", () => {
  const provider = new LocalSandboxProvider(new Context(), config);
  provider.internals = { platform: "plan9" };
  assert.throws(() => provider.confine(["bash", "-c", "printf should-not-run"], policy), /SANDBOX_UNAVAILABLE|unavailable/i);
});

test("Linux native bwrap and Landlock runners execute under the no-network wrapper", async (t) => {
  if (process.platform !== "linux" || process.env.AITEAM_SANDBOX_MATRIX !== "true") {
    t.skip("native Linux runner matrix is enabled only by the taiyi gate");
    return;
  }
  const workspace = await mkdtemp("/tmp/aiteam-sandbox-matrix-");
  try {
    for (const runner of ["bwrap", "landlock"] as const) {
      const provider = new LocalSandboxProvider(new Context(), config);
      provider.internals = { platform: "linux", chain: [runner] };
      const confined = provider.confine(["bash", "-c", "printf %s native-${RUNNER}"], { ...policy, workspaceRoot: workspace });
      const argv = networkIsolatedArgv(confined.argv);
      const result = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
        const child = spawn(argv[0]!, argv.slice(1), { cwd: workspace, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", RUNNER: runner }, stdio: ["ignore", "ignore", "ignore"] });
        child.once("error", (error) => resolve({ code: null, error }));
        child.once("close", (code) => resolve({ code }));
      });
      assert.equal(result.error, undefined, `${runner} could not be spawned`);
      assert.equal(result.code, 0, `${runner} did not execute successfully`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
