export interface SkillCatalog { catalog_id: string; skill_id: string; display_name: string; version: string; install_policy: string; binding_policy: string; visibility: string; config: Record<string,unknown>; catalog_version: number; package_status?: "draft" | "ready" | "invalid"; files?: Array<{path: string; content: string}>; content_hash?: string; }
export interface ConnectorCatalog { catalog_id: string; connector_id: string; display_name: string; visibility: string; grant_scope: string; config: Record<string,unknown>; catalog_version: number; }
export interface MemoryPolicyCatalog { catalog_id: string; policy_id: string; display_name: string; visibility: string; policy: Record<string,unknown>; seed_memories: unknown[]; retention_days?: number|null; config: Record<string,unknown>; catalog_version: number; }

export type SkillInstallPolicy = "on_demand" | "pre_install" | "pinned";
export type SkillBindingPolicy = "opt_in" | "auto_bind" | "disabled";
export type CatalogVisibility = "private" | "tenant" | "public";
export type ConnectorGrantScope = "tenant_wide" | "department_scoped" | "member_scoped" | "disabled";

export const SKILL_INSTALL_POLICIES: SkillInstallPolicy[] = ["on_demand", "pre_install", "pinned"];
export const SKILL_BINDING_POLICIES: SkillBindingPolicy[] = ["opt_in", "auto_bind", "disabled"];
export const CATALOG_VISIBILITIES: CatalogVisibility[] = ["private", "tenant", "public"];
export const CONNECTOR_GRANT_SCOPES: ConnectorGrantScope[] = ["tenant_wide", "department_scoped", "member_scoped", "disabled"];

export interface SkillCatalogIn {
  files?: Array<{ path: string; content: string }>;
  skill_id: string;
  display_name: string;
  version: string;
  install_policy: SkillInstallPolicy;
  binding_policy: SkillBindingPolicy;
  visibility: CatalogVisibility;
  config: Record<string, unknown>;
}
export interface ConnectorCatalogIn {
  connector_id: string;
  display_name: string;
  visibility: CatalogVisibility;
  grant_scope: ConnectorGrantScope;
  config: Record<string, unknown>;
}
export interface MemoryPolicyCatalogIn {
  policy_id: string;
  display_name: string;
  policy: Record<string, unknown>;
  seed_memories: unknown[];
  retention_days: number | null;
  visibility: CatalogVisibility;
  config: Record<string, unknown>;
}

/** 导入技能（设计 2026-11-20 §4.3）：文件夹 / 压缩包 / 单个 .md 走上传，其余走 JSON。 */
export type SkillImportSource = "folder" | "zip" | "file" | "text" | "url" | "clawhub";

export interface SkillImportItem {
  root: string;
  ok: boolean;
  reason?: string | null;
  name: string;
  description: string;
  version: string;
  file_count: number;
  total_bytes: number;
  files: { path: string; size: number }[];
  skipped: { path: string; reason: "platform_hook" | "binary" | "unsupported_path" }[];
  existing: "none" | "same" | "update";
  existing_version?: string | null;
}

/** ClawHub 安全扫描结论（只提示不拦截）。 */
export interface SkillSecurity {
  status: string;
  has_warnings: boolean;
  scanners: SkillSecurityScanner[];
}

export interface SkillSecurityScanner {
  name: string;
  status: string;
  verdict?: string;
  confidence?: string;
  recommendation?: string;
  severity?: string;
  issue_count?: number;
}

export interface SkillImportResult {
  root: string;
  name: string;
  version: string;
  status: "installed" | "updated" | "duplicate" | "failed";
  reason?: string | null;
  catalog_id?: string | null;
}

export interface SkillImportResponse {
  origin: { kind: SkillImportSource; label: string; url?: string | null };
  preview?: SkillImportItem | null;
  scan?: SkillImportItem[] | null;
  clawhub?: {
    candidates?: { owner: string; slug: string; url: string }[] | null;
    security?: SkillSecurity | null;
    owner?: string | null;
    slug?: string | null;
  } | null;
  results?: SkillImportResult[] | null;
}

export interface SkillImportInput {
  source: SkillImportSource;
  /** folder：每个文件带相对路径（webkitRelativePath）；zip / file：一个文件。 */
  files?: { file: File; path: string }[];
  text?: string;
  url?: string;
  roots?: string[];
  visibility?: CatalogVisibility;
  binding_policy?: SkillBindingPolicy;
  install_policy?: SkillInstallPolicy;
}
