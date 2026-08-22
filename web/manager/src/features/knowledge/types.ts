export interface KnowledgeSpace {
  knowledge_space_id: string;
  workspace: string;
  display_name: string;
  created_at?: string | null;
}
export interface KnowledgeSpaceCreate { knowledge_space_id: string; display_name?: string; }
export interface KnowledgeBinding {
  id: string; tenant_id: string; knowledge_space_id: string;
  resource_type: string; resource_id: string; created_at?: string | null;
}
export interface BindingCreate {
  resource_type: "expert" | "department" | "member"; resource_id: string;
}

// ---- 文档 intake（issue #416）----
export interface KnowledgeDocument {
  id: string; tenant_id: string; knowledge_space_id: string;
  display_name: string; source_type: "file" | "url"; file_name: string; file_type: string;
  file_size: number; storage_key: string; status: KnowledgeDocumentStatus;
  text_chars?: number | null; error_code?: string | null; error_message?: string | null;
  created_at?: string | null; updated_at?: string | null;
}
export interface KnowledgeIngestionJob {
  id: string; tenant_id: string; knowledge_space_id: string; document_id: string;
  status: "parsing" | "indexing" | "done" | "failed" | "reindex_requested";
  error_code?: string | null; error_message?: string | null;
  chunk_count?: number | null; started_at?: string | null; completed_at?: string | null;
  created_at?: string | null;
}
export interface KnowledgeDocumentBinding {
  id: string; tenant_id: string; knowledge_space_id: string; document_id: string;
  employee_id: string; rag_document_id?: string | null;
  status: "pending" | "ready" | "stale" | "revoked"; last_synced_at?: string | null; created_at?: string | null;
}
export interface KnowledgeImportUrl { url: string; display_name?: string | null; }
export const KNOWLEDGE_DOCUMENT_STATUSES = [
  "uploaded", "parsing", "indexing", "ready", "failed", "reindex_requested", "deleting", "deleted",
] as const;
export type KnowledgeDocumentStatus = (typeof KNOWLEDGE_DOCUMENT_STATUSES)[number];
export type KnowledgeOperationKind = "delete" | "reindex";
export type KnowledgeOperationStatus = "pending" | "accepted" | "failed" | "completed";
export interface KnowledgeDocumentOperation {
  operation_id: string;
  operation: KnowledgeOperationKind;
  idempotency_key: string;
  tenant_id: string;
  knowledge_space_id: string;
  document_id: string;
  status: KnowledgeOperationStatus;
  document_status: KnowledgeDocumentStatus;
  upstream_status?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

export function isKnowledgeDocumentOperation(value: unknown): value is KnowledgeDocumentOperation {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.operation_id)
    && (value.operation === "delete" || value.operation === "reindex")
    && isNonEmptyString(value.idempotency_key)
    && isNonEmptyString(value.tenant_id)
    && isNonEmptyString(value.knowledge_space_id)
    && isNonEmptyString(value.document_id)
    && (value.status === "pending" || value.status === "accepted" || value.status === "failed" || value.status === "completed")
    && KNOWLEDGE_DOCUMENT_STATUSES.includes(value.document_status as KnowledgeDocumentStatus)
    && isOptionalNullableString(value.upstream_status)
    && isOptionalNullableString(value.error_code)
    && isOptionalNullableString(value.error_message)
    && isOptionalNullableString(value.created_at)
    && isOptionalNullableString(value.updated_at)
    && isOptionalNullableString(value.completed_at);
}
