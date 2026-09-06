export interface KnowledgeSpace {
  knowledge_space_id: string;
  workspace: string;
  display_name: string;
  created_at?: string | null;
}
// ---- 文档 intake（issue #416）----
/** Unknown upstream acceptance is represented as failed + SUBMISSION_UNKNOWN/recovery_required; it remains claimable and is not retryable/deletable. */
export interface KnowledgeDocument {
  id: string; tenant_id: string; knowledge_space_id: string;
  display_name: string; source_type: "file" | "url"; file_name: string; file_type: string;
  file_size: number; storage_key: string; status: KnowledgeDocumentStatus;
  can_retry?: boolean; can_delete?: boolean; recovery_required?: boolean;
  text_chars?: number | null; error_code?: string | null; error_message?: string | null;
  created_at?: string | null; updated_at?: string | null;
}
/** A failed job can still be recoverable; only a confirmed terminal failure is retryable. */
export interface KnowledgeIngestionJob {
  attempts?: number; next_attempt_at?: string | null; recovery_required?: boolean;
  id: string; tenant_id: string; knowledge_space_id: string; document_id: string;
  status: "parsing" | "indexing" | "done" | "failed" | "reindex_requested";
  error_code?: string | null; error_message?: string | null;
  chunk_count?: number | null; started_at?: string | null; completed_at?: string | null;
  created_at?: string | null;
}
export interface KnowledgeImportUrl { url: string; display_name?: string | null; }
export const KNOWLEDGE_DOCUMENT_STATUSES = [
  "uploaded", "parsing", "indexing", "ready", "failed", "reindex_requested", "deleting", "deleted",
] as const;
export type KnowledgeDocumentStatus = (typeof KNOWLEDGE_DOCUMENT_STATUSES)[number];
export type KnowledgeOperationKind = "delete" | "reindex";
export type KnowledgeOperationStatus = "pending" | "accepted" | "failed" | "completed";
export interface KnowledgeActivityDay {
  date: string;
  activity_count: number;
  documents_created: number;
  documents_updated: number;
  ingestions: number;
  ready: number;
  failed: number;
}

export interface KnowledgeDocumentAnalytics {
  document_id: string;
  display_name: string;
  source_type: "file" | "url";
  file_name: string;
  file_type: string;
  file_size: number;
  text_chars: number | null;
  chunk_count: number | null;
  status: KnowledgeDocumentStatus;
  ingestion_status: string | null;
  upstream_status: string | null;
  error_code: string | null;
  binding_count: number;
  ready_binding_count: number;
  stale_binding_count: number;
  revoked_binding_count: number;
  pending_binding_count: number;
  ingestion_started_at: string | null;
  ingestion_completed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface KnowledgeAnalytics {
  knowledge_space_id: string;
  status: "available" | "unavailable" | "not_configured";
  document_count: number;
  ready_count: number;
  failed_count: number;
  processing_count: number;
  deleted_count: number;
  total_bytes: number;
  total_text_chars: number;
  total_chunks: number;
  upstream_document_count: number | null;
  upstream_ready_count: number | null;
  upstream_failed_count: number | null;
  upstream_processing_count: number | null;
  last_activity_at: string | null;
  refreshed_at: string;
  daily_activity: KnowledgeActivityDay[];
  documents: KnowledgeDocumentAnalytics[];
}

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
