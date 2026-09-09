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
import type { ConversationPermissionMode } from "../storage/sqlite.js";

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
  async isAvailable(workspaceRoot: string, mode: ConversationPermissionMode = "read-only"): Promise<boolean> {
    if (mode === "full-access") return true;
    try {
      const confined = this.provider.confine(["true"], this.policy(workspaceRoot, undefined, mode));
      if (confined.enforcement !== "full") return false;
      const argv = networkIsolatedArgv(confined.argv);
      return (await run(argv, resolve(workspaceRoot), { onData: () => undefined })).exitCode === 0;
    } catch (error) {
      if (error instanceof SandboxUnavailableError) return false;
      return false;
    }
  }

  async assertAvailable(workspaceRoot: string, mode: ConversationPermissionMode = "read-only"): Promise<void> {
    if (mode === "full-access") return;
    if (!(await this.isAvailable(workspaceRoot, mode))) throw new SandboxUnavailableError(mode, "No functional local sandbox backend is available");
  }

  operations(workspaceRoot: string, sessionId?: string, mode: ConversationPermissionMode = "read-only"): SandboxOperations {
    if (mode === "full-access") return this.unconfinedOperations(workspaceRoot);
    const root = canonicalPath(resolve(workspaceRoot));
    const policy = this.policy(root, sessionId, mode);
    const readOnly = mode === "read-only";
    const rejectWrite = () => { throw new Error("当前会话为只读权限，请切换到工作区可写或完全访问"); };
    return {
      bash: {
        exec: async (command, cwd, options) => {
          const actualCwd = assertWorkspacePath(cwd, root);
          const confined = this.provider.confine(["bash", "-c", command], policy);
          if (confined.enforcement !== "full") throw new SandboxUnavailableError(policy.mode, "Sandbox backend provides only partial enforcement");
          return run(networkIsolatedArgv(confined.argv), actualCwd, options);
        },
      },
      read: {
        readFile: (path) => readFile(assertWorkspacePath(path, root)),
        access: async (path) => access(assertWorkspacePath(path, root), constants.R_OK),
      },
      write: {
        writeFile: readOnly ? rejectWrite : (path, content) => writeFile(assertWorkspacePath(path, root), content),
        mkdir: readOnly ? rejectWrite : async (path) => { await mkdir(assertWorkspacePath(path, root), { recursive: true }); },
      },
      edit: {
        readFile: (path) => readFile(assertWorkspacePath(path, root)),
        writeFile: readOnly ? rejectWrite : (path, content) => writeFile(assertWorkspacePath(path, root), content),
        access: async (path) => access(assertWorkspacePath(path, root), readOnly ? constants.R_OK : constants.R_OK | constants.W_OK),
      },
    };
  }

  private unconfinedOperations(workspaceRoot: string): SandboxOperations {
    const cwd = resolve(workspaceRoot);
    return {
      bash: { exec: (command, actualCwd, options) => run(["bash", "-c", command], resolve(actualCwd || cwd), options) },
      read: { readFile: (path) => readFile(resolve(path)), access: async (path) => access(resolve(path), constants.R_OK) },
      write: { writeFile: (path, content) => writeFile(resolve(path), content), mkdir: async (path) => { await mkdir(resolve(path), { recursive: true }); } },
      edit: { readFile: (path) => readFile(resolve(path)), writeFile: (path, content) => writeFile(resolve(path), content), access: async (path) => access(resolve(path), constants.R_OK | constants.W_OK) },
    };
  }

  private policy(workspaceRoot: string, sessionId: string | undefined, mode: ConversationPermissionMode): SandboxPolicy {
    return { mode: mode === "workspace-write" ? "workspace-write" : "read-only", workspaceRoot: canonicalPath(resolve(workspaceRoot)), ...(sessionId ? { sessionId: sessionId as never } : {}) };
  }
}

/**
 * Add the platform's network deny to the provider-owned argv.
 *
 * dsh-sandbox deliberately owns filesystem effects only. Agent coding tools add
 * network isolation at this final spawn seam so a successful filesystem probe
 * cannot be reported ready while the child still has ambient network access.
 */
export function networkIsolatedArgv(argv: string[]): string[] {
  const separator = argv.indexOf("--");
  if (separator < 1) throw new SandboxUnavailableError("workspace-write", "Sandbox runner did not return a command separator");

  if (process.platform === "linux") {
    if (argv[0] === "bwrap") return [...argv.slice(0, separator), "--unshare-net", ...argv.slice(separator)];
    if (argv[0]?.endsWith("/landlock-run") || argv[0] === "landlock-run") return ["unshare", "--net", "--", ...argv];
    throw new SandboxUnavailableError("workspace-write", "Linux sandbox runner has no network isolation");
  }

  if (process.platform === "darwin" && argv[0]?.endsWith("sandbox-exec")) {
    const profileIndex = argv.indexOf("-p");
    const profile = profileIndex >= 0 ? argv[profileIndex + 1] : undefined;
    if (!profile) throw new SandboxUnavailableError("workspace-write", "Seatbelt profile is missing");
    const hardened = [...argv];
    hardened[profileIndex + 1] = `${profile} (deny network*)`;
    return hardened;
  }

  throw new SandboxUnavailableError("workspace-write", "Sandbox runner has no network isolation");
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

function scrubSandboxEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const blocked = /(?:^|_)(?:API_?KEY|PASSWORD|PASSWD|CREDENTIALS?|AUTHORIZATION|AUTH_(?:TOKEN|KEY|SECRET)|(?:[A-Z0-9]+_)?PRIVATE_?KEY|(?:DATABASE|DB|POSTGRES|MYSQL|REDIS|MONGO)_(?:URL|URI|DSN|CONNECTION_STRING)|DSN|CONNECTION_STRING)(?:_|$)|(?:^|_)(?:TOKEN|SECRET|SECRET_KEY|ENCRYPTION_KEY|MASTER_KEY|PEPPER|URL|URI|DSN|CONNECTION_STRING|KEY_PATH|PATH)$|(?:^|_)(?:ACCESS_?KEY(?:_ID)?|SECRET_ACCESS_KEY)(?:_|$)|^LIGHTRAG_(?:INSTANCES|AUTH_ACCOUNTS|TOKEN_SECRET|URL|WORKSPACE|DB_.*|ADMIN_(?:USERNAME|PASSWORD))$|^HINDSIGHT_(?:SERVICE_TOKEN|API_TOKEN|API_KEY|API_KEY_REF|CP_ACCESS_KEY)$|^PROVIDER_(?:URL|URI)$|^(?:AUTH_ACCOUNTS|TOKEN_SECRET)$|^AITEAM_CONSOLE_CREDENTIALS_FILE$|^(?:AITEAM_HINDSIGHT|HINDSIGHT|LIGHTRAG|NEWAPI|OPERATION|OPERATOR|MANAGER|SERVICE|POSTGRES|DATABASE|DB)_.+$/i;
  return Object.fromEntries(Object.entries(env).filter(([name]) => !blocked.test(name.replaceAll("-", "_"))));
}

async function run(
  argv: string[],
  cwd: string,
  options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null }> {
  if (options.signal?.aborted) throw new Error("aborted");
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0)) throw new Error("Invalid timeout");
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    detached: process.platform !== "win32",
    env: scrubSandboxEnvironment(options.env ?? process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolveRun, reject) => {
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;
    let terminationError: Error | undefined;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      options.signal?.removeEventListener("abort", abort);
      fn();
    };
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process group may have exited between the close check and kill.
        }
      }
      child.kill(signal);
    };
    const terminate = (error: Error) => {
      if (terminationError || settled) return;
      terminationError = error;
      kill("SIGTERM");
      killHandle = setTimeout(() => kill("SIGKILL"), 100);
    };
    const abort = () => terminate(new Error("aborted"));
    child.stdout?.on("data", options.onData);
    child.stderr?.on("data", options.onData);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => terminationError ? reject(terminationError) : resolveRun({ exitCode: code })));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.timeout !== undefined) {
      timeoutHandle = setTimeout(() => terminate(new Error(`timeout:${options.timeout}`)), options.timeout * 1000);
    }
  });
}
