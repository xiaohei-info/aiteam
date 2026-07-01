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
  status: "parsing" | "indexing" | "done" | "failed";
  error_code?: string | null; error_message?: string | null;
  chunk_count?: number | null; started_at?: string | null; completed_at?: string | null;
  created_at?: string | null;
}
export interface KnowledgeDocumentBinding {
  id: string; tenant_id: string; knowledge_space_id: string; document_id: string;
  employee_id: string; rag_document_id?: string | null;
  status: "pending" | "ready" | "stale"; last_synced_at?: string | null; created_at?: string | null;
}
export interface KnowledgeImportUrl { url: string; display_name?: string | null; }
export type KnowledgeDocumentStatus = "uploaded" | "parsing" | "indexing" | "ready" | "failed";
