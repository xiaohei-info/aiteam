import { lstat, opendir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { AgentSqliteStore, OwnedConversationWorkspaces } from "../storage/sqlite.js";
import { safeText } from "../pi/event-sse.js";
import { WORKSPACE_KEY_PATTERN } from "../workspace-layout.js";

export { WORKSPACE_KEY_PATTERN };

/** Directories that never count as project output. Hidden entries are skipped separately. */
const IGNORED_DIRECTORIES = new Set(["node_modules", "__pycache__", "venv"]);
/** Upper bound on directory entries inspected per workspace for `has_files`. */
export const MAX_ENTRIES_PER_WORKSPACE = 2_000;
/** Upper bound on directory entries inspected by one listing request, across all workspaces. */
export const MAX_ENTRIES_PER_REQUEST = 20_000;

/** Entries a scan may still inspect; shared by every workspace of one request. */
export class ScanBudget {
  constructor(private remaining: number) {}

  /** Takes one entry; false once the budget is spent. */
  take(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining -= 1;
    return true;
  }
}

export type ConversationWorkspaceRole = "entry" | "coordinator" | "member";

export interface ConversationWorkspaceOut {
  employee_id: string | null;
  role: ConversationWorkspaceRole;
  removed: boolean;
  workspace_key: string;
  has_files: boolean;
}

export interface ConversationWorkspacesOut {
  conversation_id: string;
  kind: string;
  title: string | null;
  entry_employee_id: string | null;
  coordinator_employee_id: string | null;
  updated_at: string;
  workspaces: ConversationWorkspaceOut[];
}

/**
 * Lists the managed working directory of every owned conversation for the desktop workbench.
 * Only directory keys leave the Agent: no absolute paths, file names or file content.
 */
export class ConversationWorkspaceService {
  constructor(private readonly store: Pick<AgentSqliteStore, "listOwnedConversationWorkspaces">, private readonly workspaceRoot: string) {}

  /**
   * Scans with async fs calls so a large tree never blocks the event loop, and spends at most
   * MAX_ENTRIES_PER_REQUEST entries in total however many conversations the member has.
   */
  async list(tenantId: string, memberId: string): Promise<ConversationWorkspacesOut[]> {
    const root = await canonical(this.workspaceRoot);
    if (!root) return [];
    const budget = new ScanBudget(MAX_ENTRIES_PER_REQUEST);
    const result: ConversationWorkspacesOut[] = [];
    for (const conversation of this.store.listOwnedConversationWorkspaces(tenantId, memberId)) {
      const workspaces = await this.workspaces(conversation, root, budget);
      if (workspaces.length === 0) continue;
      result.push({
        conversation_id: conversation.id,
        kind: conversation.kind,
        title: conversation.title ? safeText(conversation.title, 200) : null,
        entry_employee_id: conversation.entry_employee_id,
        coordinator_employee_id: conversation.coordinator_employee_id,
        updated_at: conversation.updated_at,
        workspaces,
      });
    }
    return result;
  }

  private async workspaces(conversation: OwnedConversationWorkspaces, root: string, budget: ScanBudget): Promise<ConversationWorkspaceOut[]> {
    const candidates: Array<Omit<ConversationWorkspaceOut, "workspace_key" | "has_files"> & { path: string }> = conversation.participants.map((participant) => ({
      employee_id: participant.employee_id,
      role: participant.role === "coordinator" ? "coordinator" : participant.employee_id === conversation.entry_employee_id ? "entry" : "member",
      removed: participant.removed_at !== null,
      path: participant.workspace,
    }));
    // Legacy conversations without participant rows only have the conversation-level workspace.
    if (conversation.workspace) candidates.push({ employee_id: conversation.entry_employee_id, role: "entry", removed: false, path: conversation.workspace });
    // A group's employees share one folder: one row per employee, the folder scanned once.
    const seen = new Set<string>();
    const hasFiles = new Map<string, boolean>();
    const out: ConversationWorkspaceOut[] = [];
    for (const { path, ...candidate } of candidates) {
      const key = await managedWorkspaceKey(path, root);
      const row = JSON.stringify([candidate.employee_id, key]);
      if (!key || seen.has(row)) continue;
      seen.add(row);
      if (!hasFiles.has(key)) hasFiles.set(key, await hasProjectFile(join(root, key), budget));
      out.push({ ...candidate, workspace_key: key, has_files: hasFiles.get(key)! });
    }
    return out;
  }
}

/**
 * The folder's path below the canonical `root` (`/`-separated, see WORKSPACE_KEY_PATTERN) when
 * `path` is an existing folder there. The stored path must end in the same segments as the
 * resolved one, so a symlinked folder or parent folder is never listed.
 */
export async function managedWorkspaceKey(path: string, root: string): Promise<string | null> {
  if (!path) return null;
  try {
    if (!(await lstat(path)).isDirectory()) return null;
  } catch {
    return null;
  }
  const resolved = await canonical(path);
  if (!resolved) return null;
  const key = relative(root, resolved).split(sep).join("/");
  if (!WORKSPACE_KEY_PATTERN.test(key) || join(root, key) !== resolved) return null;
  return resolve(path).endsWith(`${sep}${key.split("/").join(sep)}`) ? key : null;
}

/**
 * True when the tree holds at least one non-empty regular file outside hidden and dependency directories.
 *
 * Also true when the per-workspace or request budget runs out before an answer: the desktop then
 * lists the directory itself and drops it if it is empty, whereas a false here would hide a real
 * project for good. Entries are streamed, so a huge directory is never read into memory at once.
 */
export async function hasProjectFile(directory: string, requestBudget = new ScanBudget(MAX_ENTRIES_PER_REQUEST)): Promise<boolean> {
  const budget = new ScanBudget(MAX_ENTRIES_PER_WORKSPACE);
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try { entries = await opendir(current); } catch { continue; }
    // Breaking out of the loop closes the directory handle.
    for await (const entry of entries) {
      if (!budget.take() || !requestBudget.take()) return true;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if ((await lstat(path)).size > 0) return true;
      } catch {
        // The file can disappear while a tool is writing; keep looking.
      }
    }
  }
  return false;
}

async function canonical(path: string): Promise<string | null> {
  try { return await realpath(path); } catch { return null; }
}
