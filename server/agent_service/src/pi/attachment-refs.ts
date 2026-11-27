import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSqliteStore, LocalFileRef } from "../storage/sqlite.js";
import { hasImageSignature, IMAGE_MIMES, MAX_LOCAL_FILE_BYTES, mimeTypeForFilename } from "../local-files.js";
import { extractDocumentText, isExtractableMime, isTextMime, REFERENCE_LIMITS, UnsupportedDocumentError } from "./document-extractor.js";

/**
 * Files the desktop client attaches by path (design: clients/desktop/docs/plans/2026-11-27-attachment-by-path.md).
 * Only the location is stored; employees read the content on demand through `attachment_read`, which opens
 * nothing but the files the user attached to this conversation.
 */

export const MAX_PROMPT_ATTACHMENTS = 8;
export const ATTACHMENT_READ_TOOL_NAME = "attachment_read";
/** An image up to this size is handed to the model with the message itself, as before. */
export const MAX_INLINE_IMAGE_BYTES = MAX_LOCAL_FILE_BYTES;
/** Documents up to this size are extracted whole and paged from memory; larger plain text is paged by byte offset. */
const MAX_EXTRACT_SOURCE_BYTES = 256 * 1024 * 1024;
const DEFAULT_READ_CHARS = 20_000;
const MAX_READ_CHARS = 64_000;
const MAX_PATH_CHARS = 4096;
const MAX_NAME_CHARS = 255;

const EXTRA_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".bmp": "image/bmp", ".svg": "image/svg+xml", ".heic": "image/heic",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac",
  ".zip": "application/zip", ".rar": "application/vnd.rar", ".7z": "application/x-7z-compressed", ".gz": "application/gzip", ".tar": "application/x-tar",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".ppt": "application/vnd.ms-powerpoint",
};

export class AttachmentPathError extends Error {
  constructor(readonly code: "invalid_attachment_paths" | "attachment_not_found" | "attachment_not_a_file", message: string) {
    super(message);
    this.name = "AttachmentPathError";
  }
}

export interface AttachmentPathInput {
  path: string;
  name?: string;
}

export type ResolvedAttachmentPath = Pick<LocalFileRef, "path" | "name" | "mime_type" | "byte_size" | "mtime_ms">;

export function mimeForAttachment(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return mimeTypeForFilename(name) ?? EXTRA_MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/** Parses the request field; throws AttachmentPathError with a user-facing reason. */
export function parseAttachmentPaths(value: unknown): AttachmentPathInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AttachmentPathError("invalid_attachment_paths", "attachment_paths must be an array");
  if (value.length > MAX_PROMPT_ATTACHMENTS) throw new AttachmentPathError("invalid_attachment_paths", `A prompt may reference at most ${MAX_PROMPT_ATTACHMENTS} attachments`);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new AttachmentPathError("invalid_attachment_paths", "Each attachment path must be an object");
    const { path, name, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw new AttachmentPathError("invalid_attachment_paths", "Attachment paths only accept path and name");
    if (typeof path !== "string" || !path || path.length > MAX_PATH_CHARS || /[\u0000]/u.test(path) || !isAbsolute(path)) {
      throw new AttachmentPathError("invalid_attachment_paths", "Attachment path must be an absolute path");
    }
    if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > MAX_NAME_CHARS || /[\u0000-\u001f\u007f/\\]/u.test(name))) {
      throw new AttachmentPathError("invalid_attachment_paths", "Attachment name must be a plain file name");
    }
    return { path, ...(typeof name === "string" ? { name: name.trim() } : {}) };
  });
}

/** Follows links first, then requires an ordinary file: a folder or a device is never attached. */
export function resolveAttachmentPath(input: AttachmentPathInput): ResolvedAttachmentPath {
  let real: string;
  try {
    real = realpathSync(input.path);
  } catch {
    throw new AttachmentPathError("attachment_not_found", `附件不存在：${input.name ?? basename(input.path)}`);
  }
  const stats = statSync(real);
  if (!stats.isFile()) throw new AttachmentPathError("attachment_not_a_file", `只能附加文件，不能附加文件夹：${input.name ?? basename(input.path)}`);
  const name = input.name ?? basename(real);
  return { path: real, name, mime_type: mimeForAttachment(name), byte_size: stats.size, mtime_ms: Math.trunc(stats.mtimeMs) };
}

/** Loads a small, genuine image so it can go to the model with the message; anything else is left to the tool. */
export function loadInlineImage(ref: Pick<LocalFileRef, "path" | "mime_type" | "byte_size">): { type: "image"; data: string; mimeType: string } | undefined {
  if (!IMAGE_MIMES.has(ref.mime_type) || ref.byte_size > MAX_INLINE_IMAGE_BYTES) return undefined;
  try {
    const data = readFileSync(ref.path);
    if (data.byteLength > MAX_INLINE_IMAGE_BYTES || !hasImageSignature(ref.mime_type, data)) return undefined;
    return { type: "image", data: data.toString("base64"), mimeType: ref.mime_type };
  } catch {
    return undefined;
  }
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function kindLabel(mime: string): string {
  if (mime === "application/pdf") return "PDF";
  if (mime.includes("wordprocessingml")) return "Word 文档";
  if (mime.startsWith("image/")) return "图片";
  if (mime.startsWith("video/")) return "视频";
  if (mime.startsWith("audio/")) return "音频";
  if (isTextMime(mime) || mime.startsWith("text/")) return "文本";
  return "文件";
}

/** The list appended to the message. Paths stay inside the Agent: the model sees IDs and names only. */
export function attachmentManifest(refs: readonly LocalFileRef[], inlined: ReadonlySet<string>): string {
  if (refs.length === 0) return "";
  const lines = refs.map((ref) => {
    const note = inlined.has(ref.id) ? "，已随消息附上" : isExtractableMime(ref.mime_type) || IMAGE_MIMES.has(ref.mime_type) ? "" : "，无法读取内容";
    return `- ${ref.id}：${ref.name}（${kindLabel(ref.mime_type)}，${formatByteSize(ref.byte_size)}${note}）`;
  });
  return `\n\n[用户附件，可用 ${ATTACHMENT_READ_TOOL_NAME} 工具按编号读取]\n${lines.join("\n")}`;
}

export interface AttachmentRefOwner {
  conversationId: string;
  tenantId: string;
  memberId: string;
}

interface CachedText { key: string; text: string; format: string }
const textCache: CachedText[] = [];
const TEXT_CACHE_ENTRIES = 4;

function cachedExtract(ref: LocalFileRef, size: number, mtimeMs: number): CachedText {
  const key = `${ref.id}:${size}:${mtimeMs}`;
  const hit = textCache.find((entry) => entry.key === key);
  if (hit) return hit;
  const extracted = extractDocumentText({ filename: ref.name, mime_type: ref.mime_type }, readFileSync(ref.path), REFERENCE_LIMITS);
  const entry = { key, text: extracted.text, format: extracted.format };
  textCache.unshift(entry);
  textCache.length = Math.min(textCache.length, TEXT_CACHE_ENTRIES);
  return entry;
}

function readByteWindow(path: string, offset: number, chars: number): { text: string; next: number } {
  const length = chars * 4;
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, length, offset);
    let end = read;
    // Never cut a UTF-8 sequence in half: back off to the start of the last character.
    if (end === length) {
      let back = end - 1;
      while (back > 0 && (buffer[back]! & 0xc0) === 0x80) back -= 1;
      end = back;
    }
    return { text: buffer.subarray(0, end).toString("utf8"), next: offset + end };
  } finally {
    closeSync(fd);
  }
}

function textResult(text: string, details: Record<string, unknown>, isError = false): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details, ...(isError ? { isError: true } : {}) } as AgentToolResult<unknown>;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

export function readAttachmentRef(store: AgentSqliteStore, owner: AttachmentRefOwner, params: Record<string, unknown>): AgentToolResult<unknown> {
  const wanted = typeof params.attachment === "string" ? params.attachment.trim() : "";
  const refs = store.listOwnedLocalFileRefs(owner.conversationId, owner.tenantId, owner.memberId);
  const ref = refs.find((item) => item.id === wanted) ?? [...refs].reverse().find((item) => item.name === wanted);
  if (!ref) return textResult(`没有找到附件「${wanted}」。本会话的附件：${refs.length ? refs.map((item) => `${item.id}（${item.name}）`).join("、") : "无"}`, { attachment: wanted }, true);
  let stats;
  try {
    stats = statSync(ref.path);
  } catch {
    return textResult(`附件 ${ref.name} 已被移动或删除，无法读取。`, { attachment_id: ref.id }, true);
  }
  if (!stats.isFile()) return textResult(`附件 ${ref.name} 已被移动或删除，无法读取。`, { attachment_id: ref.id }, true);
  const mtimeMs = Math.trunc(stats.mtimeMs);
  const changed = stats.size !== ref.byte_size || mtimeMs !== ref.mtime_ms ? `（注意：文件在发送后被修改过，以下是当前内容）\n` : "";
  const details = { attachment_id: ref.id, filename: ref.name, mime_type: ref.mime_type, byte_size: stats.size };

  if (IMAGE_MIMES.has(ref.mime_type)) {
    const image = loadInlineImage({ path: ref.path, mime_type: ref.mime_type, byte_size: stats.size });
    if (!image) return textResult(`图片 ${ref.name}（${formatByteSize(stats.size)}）超过 ${formatByteSize(MAX_INLINE_IMAGE_BYTES)} 或格式无法识别，无法查看。`, details, true);
    return { content: [...(changed ? [{ type: "text" as const, text: changed }] : []), image], details } as AgentToolResult<unknown>;
  }
  if (!isExtractableMime(ref.mime_type)) {
    return textResult(`附件 ${ref.name}（${kindLabel(ref.mime_type)}，${formatByteSize(stats.size)}）不支持读取内容，只能使用它的文件名和大小。`, details, true);
  }

  const offset = integer(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(params.limit, DEFAULT_READ_CHARS, 1, MAX_READ_CHARS);
  try {
    if (stats.size > MAX_EXTRACT_SOURCE_BYTES) {
      if (!isTextMime(ref.mime_type)) return textResult(`附件 ${ref.name}（${formatByteSize(stats.size)}）太大，无法提取文字。`, details, true);
      const window = readByteWindow(ref.path, offset, limit);
      const more = window.next < stats.size ? `\n\n[第 ${offset}–${window.next} 字节，共 ${stats.size} 字节；继续读取请传 offset=${window.next}]` : `\n\n[已读到文件末尾，共 ${stats.size} 字节]`;
      return textResult(`${changed}${window.text}${more}`, { ...details, offset, next_offset: window.next, unit: "bytes" });
    }
    const extracted = cachedExtract(ref, stats.size, mtimeMs);
    const end = Math.min(extracted.text.length, offset + limit);
    const slice = extracted.text.slice(offset, end);
    const more = end < extracted.text.length ? `\n\n[第 ${offset}–${end} 字，共 ${extracted.text.length} 字；继续读取请传 offset=${end}]` : `\n\n[已读到末尾，共 ${extracted.text.length} 字]`;
    return textResult(`${changed}${slice}${more}`, { ...details, format: extracted.format, offset, next_offset: end, total_chars: extracted.text.length, unit: "chars" });
  } catch (error) {
    const reason = error instanceof UnsupportedDocumentError ? error.message : "读取失败";
    return textResult(`附件 ${ref.name} 无法读取：${reason}`.slice(0, 400), details, true);
  }
}

/** Given to every employee session: it opens nothing but the files the user attached to this conversation. */
export function createAttachmentRefReadTool(store: AgentSqliteStore, owner: () => AttachmentRefOwner): ToolDefinition {
  return {
    name: ATTACHMENT_READ_TOOL_NAME,
    label: "读取用户附件",
    description: "读取用户在本会话里附上的文件（按消息中「用户附件」清单的编号）。文本、PDF、Word 返回分段文字：用 offset/limit 翻页，按返回提示里的 offset 继续读；图片返回图片本身。只能读取本会话的附件。",
    promptSnippet: "attachment_read: 读取用户在本会话附上的文件，按附件编号分段读取",
    parameters: {
      type: "object",
      properties: {
        attachment: { type: "string", description: "附件编号（如 ref-…），也可以写文件名" },
        offset: { type: "integer", minimum: 0, description: "从第几个字开始读，默认 0" },
        limit: { type: "integer", minimum: 1, maximum: MAX_READ_CHARS, description: `本次最多读多少字，默认 ${DEFAULT_READ_CHARS}` },
      },
      required: ["attachment"],
      additionalProperties: false,
    } as never,
    execute: async (_toolCallId, params) => readAttachmentRef(store, owner(), (params ?? {}) as Record<string, unknown>),
  } as ToolDefinition;
}
