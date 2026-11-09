import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

/** A borrowed project folder is gone, replaced or otherwise no longer usable. */
export class ProjectWorkspaceUnavailableError extends Error {
  constructor() {
    super("The project directory is no longer available");
    this.name = "ProjectWorkspaceUnavailableError";
  }
}

/**
 * The opaque memory scope of one project conversation. Manager derives a separate bank from it and
 * never sees the conversation id, project name or path.
 */
export function projectMemoryScope(conversationId: string): string {
  return createHash("sha256").update(`project-conversation-v1:${conversationId}`).digest("hex").slice(0, 32);
}

/** Throws unless `path` is still a real folder at exactly the stored canonical location. */
export function assertProjectWorkspace(path: string): void {
  try {
    if (isAbsolute(path) && lstatSync(path).isDirectory() && realpathSync(path) === path) return;
  } catch { /* reported below */ }
  throw new ProjectWorkspaceUnavailableError();
}

function isInside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * True when an external folder may be worked on: never the filesystem root or home folder, nothing
 * inside Agent runtime data, and no folder that contains it.
 */
export function isAllowedProjectFolder(path: string, runtimeRoots: readonly string[], home = homedir()): boolean {
  if (path === home || path === "/") return false;
  return !runtimeRoots.some((root) => isInside(path, root) || isInside(root, path));
}
