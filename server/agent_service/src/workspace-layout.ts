import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { safePathSegment } from "./local-files.js";

/**
 * Employee working folders are named after their conversation:
 *   private chat  workspaces/<会话名>-<short id>/
 *   group chat    workspaces/<会话名>-<short id>/  (shared by every member)
 * The name is fixed when the folder is created; renaming the conversation later keeps the folder.
 * Groups of older builds keep their `<员工名>/` folders as ordinary subfolders of the shared one.
 */

/** Folder name used by builds before conversation-named folders: `conversation-<24 hex>`. */
export const LEGACY_WORKSPACE_NAME = /^conversation-[0-9a-f]{24}$/u;

/**
 * `workspace_key`: the folder's path below workspaces/, one segment for a conversation or a legacy
 * folder, two for an employee subfolder of a private chat that changed hands. Segments never start with a dot or hold separators or control
 * characters. Desktop clients validate keys with the same rule (agent_projects/fred.rs).
 */
const KEY_SEGMENT = String.raw`[^./\\\u0000-\u001f\u007f][^/\\\u0000-\u001f\u007f]{0,127}`;
export const WORKSPACE_KEY_SOURCE = `^${KEY_SEGMENT}(?:/${KEY_SEGMENT})?$`;
export const WORKSPACE_KEY_PATTERN = new RegExp(WORKSPACE_KEY_SOURCE, "u");

const NAME_CHARS = 40;
const UNTITLED = "会话";

/** One folder name segment: path separators, control and shell-hostile characters replaced, at most 40 characters. */
export function folderSegment(value: string, fallback: string): string {
  const cleaned = safePathSegment(value, fallback).replace(/[*?"<>|]+/gu, "_");
  const short = Array.from(cleaned).slice(0, NAME_CHARS).join("").replace(/[.\s]+$/u, "");
  return short || safePathSegment(fallback, fallback);
}

/** The conversation title, or `<员工名>-<YYYYMMDD>` when the conversation has none. */
export function conversationFolderBase(input: { title?: string | null; employeeName?: string | null; createdAt?: string | null }): string {
  const title = input.title?.trim();
  if (title) return folderSegment(title, UNTITLED);
  const created = input.createdAt ? new Date(input.createdAt) : new Date();
  const day = Number.isNaN(created.getTime()) ? new Date() : created;
  const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, "0")}${String(day.getDate()).padStart(2, "0")}`;
  return folderSegment(`${input.employeeName?.trim() || UNTITLED}-${stamp}`, UNTITLED);
}

function shortId(id: string, length: number): string {
  return createHash("sha256").update(id).digest("hex").slice(0, length);
}

/**
 * `<root>/<base>-<6 hex of the conversation ID>`; the hex grows to 12, then 24 characters when a
 * folder of that name already exists on disk or is `taken` by another conversation.
 */
export function conversationFolder(root: string, base: string, conversationId: string, taken: (path: string) => boolean): string {
  for (const length of [6, 12, 24]) {
    const candidate = join(root, `${base}-${shortId(conversationId, length)}`);
    if (!existsSync(candidate) && !taken(candidate)) return candidate;
  }
  throw new Error("No free workspace folder for the conversation");
}

/**
 * The conversation folder a group member's stored path belongs to: the path itself, or its parent
 * for an employee subfolder. A legacy folder still waiting to move, or a path elsewhere, has none.
 */
export function groupFolderOf(path: string, root: string): string | undefined {
  if (!path) return undefined;
  const resolved = resolve(path);
  if (dirname(resolved) === root) return LEGACY_WORKSPACE_NAME.test(basename(resolved)) ? undefined : resolved;
  return dirname(dirname(resolved)) === root ? dirname(resolved) : undefined;
}

/** `<conversation folder>/<员工名>`, for legacy folders moved into a conversation folder; a second employee of the same name gets a short ID suffix. */
export function employeeFolder(conversationDir: string, displayName: string | null | undefined, employeeId: string, taken: (path: string) => boolean): string {
  const name = folderSegment(displayName ?? "", employeeId);
  for (const candidate of [name, `${name}-${shortId(employeeId, 6)}`, `${name}-${shortId(employeeId, 24)}`]) {
    const path = join(conversationDir, candidate);
    if (!existsSync(path) && !taken(path)) return path;
  }
  throw new Error("No free workspace folder for the employee");
}

/**
 * How an employee that can write files keeps its folder tidy. A runnable app or website gets its
 * own top-level folder, where the desktop workbench looks for apps to run.
 */
/** Replaces the folder layout hint: the folder belongs to an existing project that others may be changing. */
export function projectWorkspaceHint(): string {
  return [
    "The working folder is the user's existing project, not a folder made for this conversation.",
    "- Follow its existing structure and conventions; do not reorganize it or add output/, scripts/ or data/ folders.",
    "- Other conversations may change files here at the same time, so re-read a file right before editing it and do not assume it is as you last saw it.",
  ].join("\n");
}

/** Added to the folder hint in a group chat: the folder and its write queue are shared with the other employees. */
export function groupWorkspaceHint(): string {
  return [
    "All employees of this group share this working folder and can see and change everything in it.",
    "- File changes and commands run one at a time across the group, so a call may wait for another employee to finish. Keep commands short and do not leave a server running in the foreground.",
    "- Another employee may have changed a file since you last saw it, so re-read it right before editing and keep their work.",
    "- A subfolder named after an employee may hold that employee's earlier files.",
  ].join("\n");
}

export function workspaceFolderHint(permissionMode: string | undefined, tools: readonly string[]): string {
  if (permissionMode === "read-only" || !tools.some((tool) => tool === "write" || tool === "edit" || tool === "bash")) return "";
  return [
    "Keep the working folder organized:",
    "- output/: documents, reports and other deliverables for the user",
    "- scripts/: helper scripts you write",
    "- data/: downloaded or raw data",
    "- each runnable app or website goes in its own top-level folder named after it (for example todo-app/), not inside output/",
  ].join("\n");
}
