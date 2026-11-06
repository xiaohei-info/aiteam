import { existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { hindsightStateDir } from "../pi/resources.js";
import type { AgentSqliteStore } from "../storage/sqlite.js";
import { conversationFolder, conversationFolderBase, employeeFolder, LEGACY_WORKSPACE_NAME } from "../workspace-layout.js";

type Store = Pick<AgentSqliteStore,
  "listAllConversationWorkspaces" | "listLoadedExperts" | "workspaceInUse" | "listWorkspaceMoves" | "planWorkspaceMoves" | "finishWorkspaceMove">;

export interface WorkspaceMigrationResult {
  moved: number;
  /** Moves left for the next start: the target name was taken, or the rename failed. */
  pending: number;
}

/**
 * Moves the `conversation-<hex>` folders of older builds to the conversation-named layout
 * (see workspace-layout.ts). Runs at start-up before any session. Each conversation's moves are
 * recorded first; a folder is then renamed, its Hindsight state follows, and only then do the
 * stored paths change. A crash at any point leaves a row the next start finishes, and a folder
 * already in the new layout is never touched, so running again is safe.
 */
export function migrateWorkspaceLayout(store: Store, workspaceRoot: string, agentDir: string): WorkspaceMigrationResult {
  const root = resolve(workspaceRoot);
  for (const conversation of store.listAllConversationWorkspaces()) {
    const legacy = legacyWorkspaces(conversation, root, new Set(store.listWorkspaceMoves().map((move) => move.old_path)));
    if (legacy.size === 0) continue;
    try { store.planWorkspaceMoves(plan(store, root, conversation, legacy)); } catch { /* retried next start */ }
  }
  const result: WorkspaceMigrationResult = { moved: 0, pending: 0 };
  for (const move of store.listWorkspaceMoves()) {
    let done = false;
    try { done = finishMove(store, agentDir, move.old_path, move.new_path); } catch { /* retried next start */ }
    if (done) result.moved += 1;
    else result.pending += 1;
  }
  return result;
}

type Conversation = ReturnType<Store["listAllConversationWorkspaces"]>[number];

/** Legacy folder paths of the conversation and the employee each belongs to; already planned ones are left out. */
function legacyWorkspaces(conversation: Conversation, root: string, planned: Set<string>): Map<string, string | null> {
  const legacy = new Map<string, string | null>();
  const candidates: Array<readonly [string, string | null]> = conversation.participants.map((participant) => [participant.workspace, participant.employee_id] as const);
  candidates.push([conversation.workspace, conversation.entry_employee_id]);
  for (const [path, employeeId] of candidates) {
    if (!path || planned.has(path) || legacy.has(path)) continue;
    if (resolve(path) !== join(root, basename(path)) || !LEGACY_WORKSPACE_NAME.test(basename(path))) continue;
    legacy.set(path, employeeId);
  }
  return legacy;
}

function plan(store: Store, root: string, conversation: Conversation, legacy: Map<string, string | null>): Array<{ oldPath: string; newPath: string }> {
  const experts = store.listLoadedExperts(conversation.tenant_id ?? undefined, conversation.member_id ?? undefined, true);
  const displayName = (employeeId: string | null) => employeeId ? experts.find((expert) => expert.employee_id === employeeId)?.display_name : undefined;
  // A private chat whose folder changed hands has several folders: they become employee subfolders like a group's.
  const group = conversation.kind === "group" || conversation.coordinator_employee_id !== null || legacy.size > 1;
  if (!group) {
    const [[oldPath, employeeId]] = legacy;
    const base = conversationFolderBase({ title: conversation.title, employeeName: displayName(employeeId), createdAt: conversation.created_at });
    return [{ oldPath, newPath: conversationFolder(root, base, conversation.id, (path) => store.workspaceInUse(path)) }];
  }
  // Members created after the upgrade already sit in the conversation's folder.
  const shared = conversation.participants.map((participant) => participant.workspace)
    .find((path) => path && dirname(dirname(resolve(path))) === root);
  const leader = conversation.coordinator_employee_id ?? conversation.entry_employee_id ?? [...legacy.values()][0] ?? null;
  const conversationDir = shared
    ? dirname(resolve(shared))
    : conversationFolder(root, conversationFolderBase({ title: conversation.title, employeeName: displayName(leader), createdAt: conversation.created_at }), conversation.id, (path) => store.workspaceInUse(path));
  const chosen = new Set<string>();
  return [...legacy].map(([oldPath, employeeId]) => {
    const newPath = employeeFolder(conversationDir, displayName(employeeId), employeeId ?? "conversation", (path) => chosen.has(path) || store.workspaceInUse(path));
    chosen.add(newPath);
    return { oldPath, newPath };
  });
}

/** True once the stored paths point at `newPath`; false leaves the move for the next start. */
function finishMove(store: Store, agentDir: string, oldPath: string, newPath: string): boolean {
  let old;
  try { old = lstatSync(oldPath); } catch { old = undefined; }
  if (old) {
    // Never follow or move a link or file that sits where the folder was.
    if (!old.isDirectory()) return false;
    if (existsSync(newPath)) return false;
    mkdirSync(dirname(newPath), { recursive: true, mode: 0o700 });
    renameSync(oldPath, newPath);
  }
  const fromState = hindsightStateDir(agentDir, oldPath);
  const toState = hindsightStateDir(agentDir, newPath);
  if (existsSync(fromState) && !existsSync(toState)) renameSync(fromState, toState);
  store.finishWorkspaceMove(oldPath, newPath);
  return true;
}
