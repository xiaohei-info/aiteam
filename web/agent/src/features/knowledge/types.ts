export type DocumentStatus = "uploaded" | "ingesting" | "ready" | "error";
export type IngestionStatus = "pending" | "parsing" | "inserting" | "completed" | "failed";
export type DocumentSourceKind = "file" | "url";

export interface KnowledgeBase {
  kb_id: string;
  name: string;
  description: string;
  doc_count: number;
  size_kb: number;
  source_type: string;
  sync_status: string;
}

export interface KnowledgeSearchResult {
  doc_id: string;
  title: string;
  snippet: string;
  score: number;
}

export interface KnowledgeDocument {
  doc_id: string;
  kb_id: string;
  title: string;
  snippet: string;
  content_type: string;
  size: number;
  status: DocumentStatus;
  rag_document_id: string;
  ingestion_job_id: string | null;
  error_code: string | null;
  error_message: string | null;
  chunk_count: number;
  source_kind: DocumentSourceKind;
  source_url: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeIngestion {
  job_id: string;
  kb_id: string;
  document_id: string;
  status: IngestionStatus;
  rag_document_id: string;
  error_message: string | null;
  chunk_count: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}
