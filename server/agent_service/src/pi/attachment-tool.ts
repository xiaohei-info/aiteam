import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSqliteStore, LocalFileRecord } from "../storage/sqlite.js";
import { extractDocument, MAX_DOCUMENT_TOTAL_CHARS, type ExtractedDocument } from "./document-extractor.js";

export interface AttachmentOwner {
  tenantId: string;
  memberId: string;
  conversationId: string;
}

export interface MaterializedAttachment extends LocalFileRecord {
  extracted: ExtractedDocument;
}

/** Read only owner-bound attachment bytes; never accepts a filesystem path. */
export function materializeAttachment(store: AgentSqliteStore, owner: AttachmentOwner, attachmentId: string): MaterializedAttachment {
  const loaded = store.readOwnedLocalFile(attachmentId, owner.conversationId, owner.tenantId, owner.memberId);
  if (!loaded || loaded.record.kind !== "attachment") throw new Error("Attachment is not available to this conversation");
  return { ...loaded.record, extracted: extractDocument(loaded.record, loaded.data) };
}

export function materializeAttachments(store: AgentSqliteStore, owner: AttachmentOwner, attachmentIds: readonly string[]): MaterializedAttachment[] {
  if (attachmentIds.length > 8) throw new Error("A prompt may reference at most 8 attachments");
  const output: MaterializedAttachment[] = [];
  let chars = 0;
  for (const id of attachmentIds) {
    const materialized = materializeAttachment(store, owner, id);
    chars += materialized.extracted.text.length;
    if (chars > MAX_DOCUMENT_TOTAL_CHARS) throw new Error("Attachment text exceeds the materialization limit");
    output.push(materialized);
  }
  return output;
}

/**
 * Optional Pi custom tool for a prompt that explicitly carries local attachment
 * IDs. It is intentionally not enabled globally; HTTP prompt materialization is
 * the normal path and this helper is useful for controlled extension wiring.
 */
export function createAttachmentReadTool(store: AgentSqliteStore, owner: AttachmentOwner, attachmentIds: readonly string[]): ToolDefinition {
  const allowed = new Set(attachmentIds);
  return {
    name: "attachment_read",
    label: "Read local attachment",
    description: "Read bounded text from a local attachment already attached to this conversation.",
    parameters: {
      type: "object",
      properties: { attachment_id: { type: "string" } },
      required: ["attachment_id"],
      additionalProperties: false,
    } as never,
    execute: async (_toolCallId, params) => {
      const id = (params as { attachment_id?: unknown }).attachment_id;
      if (typeof id !== "string" || !allowed.has(id)) return errorResult("Attachment is not attached to this prompt");
      try {
        const materialized = materializeAttachment(store, owner, id);
        return {
          content: [{ type: "text", text: materialized.extracted.text }],
          details: { attachment_id: id, filename: materialized.filename, format: materialized.extracted.format },
        } as AgentToolResult<unknown>;
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "Attachment could not be read");
      }
    },
  } as ToolDefinition;
}

function errorResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: text.slice(0, 240) }], details: {} };
}
