import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative } from "node:path";
import { scanWorkspaceFiles, type WorkspaceFile } from "../local-files.js";
import type { AgentSqliteStore, UnplacedArtifact } from "../storage/sqlite.js";

type Store = Pick<AgentSqliteStore, "listUnplacedArtifacts" | "setArtifactPath" | "listOwnedConversationWorkspaces">;

/**
 * Artifacts captured before paths were recorded only kept their file name. Each one is matched by
 * name, size and SHA-256 against the files still in its conversation's workspaces; a file that is
 * gone or was changed since is placed at the top level. Every artifact is placed once, so later
 * starts do no work. Returns how many artifacts were placed.
 */
export async function backfillArtifactPaths(store: Store, workspaceRoot: string): Promise<number> {
  const pending = store.listUnplacedArtifacts();
  if (pending.length === 0) return 0;
  const byConversation = new Map<string, UnplacedArtifact[]>();
  for (const artifact of pending) {
    const key = JSON.stringify([artifact.tenant_id, artifact.member_id, artifact.conversation_id]);
    byConversation.set(key, [...(byConversation.get(key) ?? []), artifact]);
  }
  let root: string | undefined;
  try { root = realpathSync(workspaceRoot); } catch { /* no workspaces yet: everything goes to the top level */ }
  let placed = 0;
  for (const artifacts of byConversation.values()) {
    const { tenant_id: tenantId, member_id: memberId, conversation_id: conversationId } = artifacts[0];
    const candidates = root ? await workspaceFiles(store, root, tenantId, memberId, conversationId) : [];
    // Identical copies of one file at two paths each take their own path.
    const taken = new Set<string>();
    for (const artifact of artifacts) {
      try {
        store.setArtifactPath(artifact.id, findPath(artifact, candidates, taken) ?? artifact.filename);
        placed += 1;
      } catch {
        // An invalid stored name stays unplaced and is listed without a folder.
      }
    }
  }
  return placed;
}

interface Candidate extends WorkspaceFile { artifactPath: string }

async function workspaceFiles(store: Store, root: string, tenantId: string, memberId: string, conversationId: string): Promise<Candidate[]> {
  const conversation = store.listOwnedConversationWorkspaces(tenantId, memberId).find((item) => item.id === conversationId);
  if (!conversation) return [];
  const group = conversation.kind === "group" || conversation.coordinator_employee_id !== null;
  const workspaces = conversation.participants.map((participant) => ({ employeeId: participant.employee_id as string | null, path: participant.workspace }));
  if (conversation.workspace) workspaces.push({ employeeId: conversation.entry_employee_id, path: conversation.workspace });
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const workspace of workspaces) {
    const resolved = inside(workspace.path, root);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    const prefix = group && workspace.employeeId
      ? `${basename(workspace.path)}/`
      : "";
    for (const [path, file] of await scanWorkspaceFiles(resolved)) out.push({ ...file, artifactPath: `${prefix}${path}` });
  }
  return out.sort((a, b) => a.artifactPath.localeCompare(b.artifactPath));
}

function findPath(artifact: UnplacedArtifact, candidates: Candidate[], taken: Set<string>): string | undefined {
  for (const candidate of candidates) {
    if (taken.has(candidate.artifactPath)) continue;
    if (candidate.size !== artifact.byte_size || candidate.artifactPath.split("/").at(-1) !== artifact.filename) continue;
    try {
      if (createHash("sha256").update(readFileSync(candidate.path)).digest("hex") === artifact.sha256) {
        taken.add(candidate.artifactPath);
        return candidate.artifactPath;
      }
    } catch {
      // The file vanished between the scan and the read.
    }
  }
  return undefined;
}

/** Canonical path when `path` is an existing directory under `root`. */
function inside(path: string, root: string): string | undefined {
  if (!path) return undefined;
  try {
    const resolved = realpathSync(path);
    const rel = relative(root, resolved);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? resolved : undefined;
  } catch {
    return undefined;
  }
}
