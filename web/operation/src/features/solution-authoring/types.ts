/** 行业文档生成（/api/operation/solution-authoring）的前端类型，与后端 schema 一一对应。 */

export type DraftStatus =
  | "draft" | "generating" | "ready_for_review" | "in_review" | "approved" | "published" | "rejected" | "archived";
export type ImageRecognition = "none" | "vision";
export type JobStatus = "queued" | "parsing" | "analyzing" | "succeeded" | "failed";
export type FindingStatus = "open" | "redacted" | "removed" | "accepted_public" | "acknowledged";
export type FindingResolution = "redact" | "remove" | "accept_public" | "acknowledge";

export interface ModelRef { provider_id: string; model_id: string; }

export interface DraftSummary {
  draft_id: string;
  title: string;
  status: DraftStatus;
  platform_model_ref: ModelRef;
  image_recognition: ImageRecognition;
  version: number;
  published_solution_id: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface Evidence { chunk_id: string; quote?: string; }

export interface GeneratedExpert {
  key: string;
  display_name: string;
  category: string;
  description: string;
  system_prompt: string;
  evidence: Evidence[];
}

export interface GeneratedSolution {
  display_name: string;
  description: string;
  tags: string[];
  coordinator_key: string;
  coordinator_instructions: string;
  output_requirements: string;
  experts: GeneratedExpert[];
  evidence: Evidence[];
}

export interface SourceDocument {
  source_id: string;
  file_name: string;
  size_bytes: number;
  status: "uploaded" | "parsed" | "failed";
  error_code: string | null;
  chunk_count: number;
  image_count: number;
  warnings: string[];
  created_at: string;
}

export interface GenerationJob {
  job_id: string;
  status: JobStatus;
  attempt: number;
  error_code: string | null;
  error_message: string | null;
  usage: Record<string, number>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Finding {
  finding_id: string;
  kind: string;
  origin: "rule" | "agent" | "system";
  /** 空串表示该项不在正文中，只能「确认已知悉」。 */
  field_path: string;
  masked: string;
  locator: string;
  note: string;
  status: FindingStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface EvidenceSource {
  source_name: string;
  locator: string;
  excerpt: string;
  origin: "text" | "image";
  low_confidence: boolean;
}

export interface ReviewEvent { action: string; actor_id: string; summary: string; created_at: string; }

export interface DraftDetail extends DraftSummary {
  supplement: string;
  package: GeneratedSolution | null;
  evidence_sources: Record<string, EvidenceSource>;
  warnings: Array<{ file_name: string; code: string }>;
  prompt_version: string;
  usage: Record<string, number>;
  review_note: string;
  sources: SourceDocument[];
  findings: Finding[];
  open_finding_count: number;
  events: ReviewEvent[];
  latest_job: GenerationJob | null;
}

export interface DraftCreateInput {
  title: string;
  platform_model_ref: ModelRef;
  image_recognition: ImageRecognition;
  supplement: string;
}

/** 可增删资料、可发起生成的状态。 */
export const EDITABLE_STATUSES: readonly DraftStatus[] = ["draft", "ready_for_review", "rejected"];
/** 可编辑正文、处理敏感项、提交审核的状态。 */
export const CONTENT_STATUSES: readonly DraftStatus[] = ["ready_for_review", "rejected"];
