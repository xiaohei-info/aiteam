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
}

export interface DownloadedSkill {
  skill_id: string;
  version: string;
  content_hash: string;
  status: "draft" | "published";
}

export interface PlatformSkillRef {
  skill_id: string;
  version: string;
  content_hash: string;
}
