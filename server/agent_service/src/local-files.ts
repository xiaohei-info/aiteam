import { lstat, opendir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export const MAX_LOCAL_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ARTIFACT_PATH_CHARS = 1_024;
/** Keep artifact discovery bounded like the workspace project scan. */
export const MAX_ARTIFACT_ENTRIES_PER_DIRECTORY = 2_000;
export const MAX_ARTIFACT_ENTRIES_PER_SCAN = 20_000;
/** Dependency and cache folders are tool output, not something the employee made. */
const IGNORED_WORKSPACE_DIRECTORIES = new Set(["node_modules", "__pycache__", "venv"]);
export const IMAGE_MIMES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
export const AUDIO_MIMES = new Set([
  "audio/aac", "audio/flac", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/opus", "audio/wav", "audio/webm", "audio/x-wav",
]);

/** MIME types that stay local to the Agent file store. */
export const ALLOWED_FILE_MIMES = new Set([
  "application/json",
  "application/msword",
  "application/octet-stream",
  "application/pdf",
  "application/rtf",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/xml",
  "application/yaml",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/css",
  "text/html",
  "text/javascript",
  "text/markdown",
  "text/plain",
  "text/typescript",
  "text/xml",
  "text/yaml",
]);

const ARTIFACT_MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".bash", "text/plain"],
  [".c", "text/plain"],
  [".cc", "text/plain"],
  [".cfg", "text/plain"],
  [".conf", "text/plain"],
  [".cpp", "text/plain"],
  [".cxx", "text/plain"],
  [".css", "text/css"],
  [".csv", "text/csv"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".go", "text/plain"],
  [".h", "text/plain"],
  [".hpp", "text/plain"],
  [".htm", "text/html"],
  [".html", "text/html"],
  [".ini", "text/plain"],
  [".java", "text/plain"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".jsx", "text/javascript"],
  [".kt", "text/plain"],
  [".kts", "text/plain"],
  [".log", "text/plain"],
  [".markdown", "text/markdown"],
  [".md", "text/markdown"],
  [".mjs", "text/javascript"],
  [".cjs", "text/javascript"],
  [".pdf", "application/pdf"],
  [".php", "text/plain"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".py", "text/plain"],
  [".rb", "text/plain"],
  [".rs", "text/plain"],
  [".sh", "text/plain"],
  [".sql", "text/plain"],
  [".svelte", "text/html"],
  [".swift", "text/plain"],
  [".toml", "text/plain"],
  [".ts", "text/typescript"],
  [".tsx", "text/typescript"],
  [".txt", "text/plain"],
  [".vue", "text/html"],
  [".xml", "application/xml"],
  [".yaml", "text/yaml"],
  [".yml", "text/yaml"],
  [".webp", "image/webp"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
]);

const SENSITIVE_ARTIFACT_NAME = /(?:^|[._-])(env|secret|secrets|credential|credentials|password|passwd|token|private|api[_-]?key|access[_-]?key)(?:$|[._-])/iu;
const SENSITIVE_ARTIFACT_CONTENT = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|(?:api[_-]?key|client[_-]?secret|password|passwd|authorization|access[_-]?token)["']?\s*[:=]\s*["']?[^\s"']{8,}/iu;

export function mimeTypeForFilename(filename: string): string | undefined {
  return ARTIFACT_MIME_BY_EXTENSION.get(extname(filename).toLowerCase());
}

/** Only regular, non-hidden, non-secret-looking names are eligible for capture. */
export function isSafeArtifactFilename(filename: string): boolean {
  const name = basename(filename);
  return name === filename && !name.startsWith(".") && !SENSITIVE_ARTIFACT_NAME.test(name);
}

/** A `/`-separated path inside a workspace whose every segment is a safe artifact name. */
export function isSafeArtifactPath(path: string): boolean {
  if (!path || path.length > MAX_ARTIFACT_PATH_CHARS || /[\u0000-\u001f\u007f\\]/u.test(path)) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment.length <= 255 && !segment.startsWith("."));
}

/** One readable path segment from a display name: no separators, control characters or leading dots. */
export function safePathSegment(value: string | null | undefined, fallback: string): string {
  const cleaned = (value ?? "").replace(/[\u0000-\u001f\u007f/\\:]+/gu, "_").replace(/^[.\s]+/u, "").trim().slice(0, 64).trim();
  return cleaned || fallback.replace(/[^A-Za-z0-9_-]+/gu, "_").slice(0, 64) || "_";
}

export interface WorkspaceFile {
  path: string;
  size: number;
  mtimeMs: number;
  scannedAtMs: number;
  mimeType: string;
}

/**
 * Files an employee made in its workspace, keyed by `/`-separated path from the root. Hidden entries,
 * symlinks, dependency folders and Python virtual environments are skipped.
 */
export async function scanWorkspaceFiles(root: string): Promise<Map<string, WorkspaceFile>> {
  const files = new Map<string, WorkspaceFile>();
  const pending: Array<{ directory: string; prefix: string }> = [{ directory: root, prefix: "" }];
  let remaining = MAX_ARTIFACT_ENTRIES_PER_SCAN;
  while (pending.length > 0 && remaining > 0) {
    const current = pending.pop()!;
    let entries;
    try { entries = await opendir(current.directory); } catch { continue; }
    let inspected = 0;
    for await (const entry of entries) {
      if (inspected >= MAX_ARTIFACT_ENTRIES_PER_DIRECTORY || remaining <= 0) break;
      inspected += 1;
      remaining -= 1;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const path = join(current.directory, entry.name);
      const pathFromRoot = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_WORKSPACE_DIRECTORIES.has(entry.name)) continue;
        try { await lstat(join(path, "pyvenv.cfg")); continue; } catch { /* ordinary directory */ }
        pending.push({ directory: path, prefix: pathFromRoot });
        continue;
      }
      if (!entry.isFile() || !isSafeArtifactFilename(entry.name) || !isSafeArtifactPath(pathFromRoot)) continue;
      const mimeType = mimeTypeForFilename(entry.name);
      if (!mimeType) continue;
      try {
        const info = await lstat(path);
        if (info.isFile()) files.set(pathFromRoot, { path, size: info.size, mtimeMs: info.mtimeMs, scannedAtMs: Date.now(), mimeType });
      } catch {
        // A file can disappear while a tool is writing it; ignore that snapshot.
      }
    }
  }
  return files;
}

/** Keep obvious credentials out of generated artifacts even when a safe extension is used. */
export function containsLikelySecret(data: Buffer, mimeType: string): boolean {
  if (!mimeType.startsWith("text/") && mimeType !== "application/json" && mimeType !== "application/xml" && mimeType !== "application/yaml") return false;
  return SENSITIVE_ARTIFACT_CONTENT.test(data.toString("utf8"));
}

export function hasImageSignature(mimeType: string, data: Buffer): boolean {
  if (mimeType === "image/png") return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/jpeg") return data.length >= 3 && data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (mimeType === "image/gif") return data.length >= 6 && (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a");
  if (mimeType === "image/webp") return data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}
