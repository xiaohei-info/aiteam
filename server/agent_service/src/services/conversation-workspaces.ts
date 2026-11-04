import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentSqliteStore, OwnedConversationWorkspaces } from "../storage/sqlite.js";
import { safeText } from "../pi/event-sse.js";

/** Managed workspace directory name produced by SessionHost.safeDirectoryName. */
export const WORKSPACE_KEY_PATTERN = /^conversation-[0-9a-f]{24}$/u;

/** Directories that never count as project output. Hidden entries are skipped separately. */
const IGNORED_DIRECTORIES = new Set(["node_modules", "__pycache__", "venv"]);
/** Upper bound on directory entries inspected per workspace for `has_files`. */
const MAX_ENTRIES_INSPECTED = 2_000;

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

  list(tenantId: string, memberId: string): ConversationWorkspacesOut[] {
    const root = canonical(this.workspaceRoot);
    if (!root) return [];
    const result: ConversationWorkspacesOut[] = [];
    for (const conversation of this.store.listOwnedConversationWorkspaces(tenantId, memberId)) {
      const workspaces = this.workspaces(conversation, root);
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

  private workspaces(conversation: OwnedConversationWorkspaces, root: string): ConversationWorkspaceOut[] {
    const candidates: Array<Omit<ConversationWorkspaceOut, "workspace_key" | "has_files"> & { path: string }> = conversation.participants.map((participant) => ({
      employee_id: participant.employee_id,
      role: participant.role === "coordinator" ? "coordinator" : participant.employee_id === conversation.entry_employee_id ? "entry" : "member",
      removed: participant.removed_at !== null,
      path: participant.workspace,
    }));
    // Legacy conversations without participant rows only have the conversation-level workspace.
    if (conversation.workspace) candidates.push({ employee_id: conversation.entry_employee_id, role: "entry", removed: false, path: conversation.workspace });
    const seen = new Set<string>();
    const out: ConversationWorkspaceOut[] = [];
    for (const { path, ...candidate } of candidates) {
      const key = managedWorkspaceKey(path, root);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ ...candidate, workspace_key: key, has_files: hasProjectFile(join(root, key)) });
    }
    return out;
  }
}

/** Returns the directory key when `path` is an existing, non-symlinked direct child of `root`. */
export function managedWorkspaceKey(path: string, root: string): string | null {
  if (!path) return null;
  const key = basename(path);
  if (!WORKSPACE_KEY_PATTERN.test(key)) return null;
  try {
    if (!lstatSync(path).isDirectory()) return null;
  } catch {
    return null;
  }
  const resolved = canonical(path);
  return resolved && dirname(resolved) === root && basename(resolved) === key ? key : null;
}

/** True when the tree holds at least one non-empty regular file outside hidden and dependency directories. */
export function hasProjectFile(directory: string): boolean {
  let budget = MAX_ENTRIES_INSPECTED;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (--budget < 0) return false;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if (lstatSync(path).size > 0) return true;
      } catch {
        // The file can disappear while a tool is writing; keep looking.
      }
    }
  }
  return false;
}

function canonical(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}
