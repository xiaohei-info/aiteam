import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isAllowedProjectFolder } from "./project-path-policy.js";

export { isAllowedProjectFolder } from "./project-path-policy.js";

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