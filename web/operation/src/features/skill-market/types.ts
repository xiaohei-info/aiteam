export interface ExternalSkill {
  owner: string;
  slug: string;
  display_name: string;
  summary: string;
  version?: string | null;
  latest_version?: string | null;
  updated_at?: number | null;
  downloads: number;
  canonical_url: string;
}

export interface InternalSkill {
  skill_id: string;
  owner: string;
  slug: string;
  display_name: string;
  summary: string;
  latest_external_version?: string | null;
  latest_internal_version?: string | null;
  published_version?: string | null;
  latest_content_hash?: string | null;
  content_hash?: string | null;
  status: "draft" | "published" | "unpublished" | "blocked";
  latest_version_status?: "draft" | "published";
  /** 最新版本导入时的 ClawHub 安全扫描结论（只提示，不拦截）。 */
  security?: SkillSecurity | null;
}

/** ClawHub 单个扫描器的结论；两个扫描器并列展示，不合并成一个词。 */
export interface SkillSecurityScanner {
  name: string;
  status: string;
  verdict?: string | null;
  confidence?: string | null;
  recommendation?: string | null;
  severity?: string | null;
  issue_count?: number | null;
}

export interface SkillSecurity {
  status: string;
  has_warnings: boolean;
  scanners: SkillSecurityScanner[];
}

export interface SkippedFile {
  path: string;
  reason: "platform_hook" | "binary" | "unsupported_path";
}

export interface ExternalSkillPreview {
  owner: string;
  slug: string;
  display_name: string;
  summary: string;
  version: string;
  canonical_url: string;
  files: { path: string; size: number }[];
  total_bytes: number;
  skipped: SkippedFile[];
  security: SkillSecurity | null;
  imported_version: string | null;
}

export interface ClawHubCandidate {
  owner: string;
  slug: string;
  url: string;
}

export interface ClawHubResolve {
  slug: string;
  owner: string | null;
  candidates: ClawHubCandidate[];
}

export interface DownloadedSkill {
  skill_id: string;
  version: string;
  content_hash: string;
  status: "draft" | "published";
  owner?: string;
  slug?: string;
  display_name?: string;
  skipped?: SkippedFile[];
  security?: SkillSecurity | null;
}

export interface PlatformSkillRef {
  skill_id: string;
  version: string;
  content_hash: string;
}
