import { spawn } from "node:child_process";
import { constants, existsSync, realpathSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
import { canonicalPath, SandboxUnavailableError, type SandboxPolicy } from "@deepseek-ai/dsh-sandbox";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { EditOperations } from "@earendil-works/pi-coding-agent";
import type { ReadOperations } from "@earendil-works/pi-coding-agent";
import type { WriteOperations } from "@earendil-works/pi-coding-agent";

const LOCAL_PROVIDER_CONFIG = { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5_000 };

export interface SandboxOperations {
  bash: BashOperations;
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
}

export class LocalSandbox {
  private readonly context = new Context();
  private readonly provider = new LocalSandboxProvider(this.context, LOCAL_PROVIDER_CONFIG);

  /** Run the provider's real backend selection/probe; no environment flag participates. */
  async isAvailable(workspaceRoot: string): Promise<boolean> {
    try {
      const confined = this.provider.confine(["true"], this.policy(workspaceRoot));
      return (await run(confined.argv, resolve(workspaceRoot), { onData: () => undefined })).exitCode === 0;
    } catch (error) {
      if (error instanceof SandboxUnavailableError) return false;
      return false;
    }
  }

  async assertAvailable(workspaceRoot: string): Promise<void> {
    if (!(await this.isAvailable(workspaceRoot))) throw new SandboxUnavailableError("workspace-write", "No functional local sandbox backend is available");
  }

  operations(workspaceRoot: string, sessionId?: string): SandboxOperations {
    const root = canonicalPath(resolve(workspaceRoot));
    const policy = this.policy(root, sessionId);
    return {
      bash: {
        exec: async (command, cwd, options) => {
          const actualCwd = assertWorkspacePath(cwd, root);
          const confined = this.provider.confine(["bash", "-c", command], { ...policy, workspaceRoot: root });
          return run(confined.argv, actualCwd, options);
        },
      },
      read: {
        readFile: (path) => readFile(assertWorkspacePath(path, root)),
        access: async (path) => access(assertWorkspacePath(path, root), constants.R_OK),
      },
      write: {
        writeFile: (path, content) => writeFile(assertWorkspacePath(path, root), content),
        mkdir: async (path) => { await mkdir(assertWorkspacePath(path, root), { recursive: true }); },
      },
      edit: {
        readFile: (path) => readFile(assertWorkspacePath(path, root)),
        writeFile: (path, content) => writeFile(assertWorkspacePath(path, root), content),
        access: async (path) => access(assertWorkspacePath(path, root), constants.R_OK | constants.W_OK),
      },
    };
  }

  private policy(workspaceRoot: string, sessionId?: string): SandboxPolicy {
    return { mode: "workspace-write", workspaceRoot: canonicalPath(resolve(workspaceRoot)), ...(sessionId ? { sessionId: sessionId as never } : {}) };
  }
}

/** Resolve a tool path through its nearest existing parent, rejecting symlink escapes. */
export function assertWorkspacePath(path: string, workspaceRoot: string): string {
  const absolute = resolve(workspaceRoot, path);
  const root = canonicalPath(resolve(workspaceRoot));
  let existing = absolute;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error("Path escapes the session workspace");
    suffix.push(basename(existing));
    existing = parent;
  }
  const candidate = resolve(realpathSync(existing), ...suffix.reverse());
  const escaped = relative(root, candidate);
  if (escaped.startsWith("..") || isAbsolute(escaped)) throw new Error("Path escapes the session workspace");
  return candidate;
}

async function run(
  argv: string[],
  cwd: string,
  options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null }> {
  if (options.signal?.aborted) throw new Error("aborted");
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolveRun, reject) => {
    let timeoutHandle: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", abort);
      fn();
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("aborted")));
    };
    child.stdout?.on("data", options.onData);
    child.stderr?.on("data", options.onData);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => resolveRun({ exitCode: code })));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.timeout !== undefined) {
      if (!Number.isFinite(options.timeout) || options.timeout <= 0) return finish(() => reject(new Error("Invalid timeout")));
      timeoutHandle = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new Error(`timeout:${options.timeout}`)));
      }, options.timeout * 1000);
    }
  });
}