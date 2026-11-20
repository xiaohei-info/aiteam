/**
 * 技能导入 / 编辑的前端类型（企业端与运营端共用；设计 2026-11-20 §4.3 / §4.7）。
 *
 * 一个技能 = 一个含 SKILL.md 的文件夹：SKILL.md 开头的 name、description，正文是指令，
 * 另可附带 scripts/、references/、assets/ 等文本文件（Agent Skills 规范，pi 同口径）。
 */

/** 技能的一个文件（UTF-8 文本）。 */
export interface SkillFile {
  path: string;
  content: string;
}

/** 来源：上传文件夹 / zip / 单个 .md、粘贴 SKILL.md、在线编辑、网址、ClawHub（只有企业端有）。 */
export type SkillImportSource = "folder" | "zip" | "file" | "text" | "editor" | "url" | "clawhub";

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
  skipped: { path: string; reason: "platform_hook" | "binary" | "unsupported_path" | string }[];
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
  /** 企业端：写入的目录条目。 */
  catalog_id?: string | null;
  /** 运营端：平台技能 ID。 */
  skill_id?: string | null;
}

export interface SkillImportResponse {
  origin: { kind: SkillImportSource | string; label: string; url?: string | null };
  preview?: SkillImportItem | null;
  scan?: SkillImportItem[] | null;
  clawhub?: {
    candidates?: { owner: string; slug: string; url: string }[] | null;
    security?: SkillSecurity | null;
    owner?: string | null;
    slug?: string | null;
  } | null;
  results?: SkillImportResult[] | null;
  /** 运营端：保存后是否已自动开放给企业。 */
  auto_publish?: boolean | null;
}

export interface SkillImportInput {
  source: SkillImportSource;
  /** folder / editor：每个文件带相对路径；zip / file：一个文件。 */
  files?: { file: File; path: string }[];
  text?: string;
  url?: string;
  roots?: string[];
}

/** 导入对话框需要的两个接口：检查（不写库）与保存。 */
export interface SkillImportApi {
  preview: (input: SkillImportInput) => Promise<SkillImportResponse | null>;
  save: (input: SkillImportInput) => Promise<SkillImportResponse | null>;
}
