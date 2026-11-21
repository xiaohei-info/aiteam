import type { CapabilityProvenance } from "@aiteam/shared";

export interface PlatformSkillMarketItem {
  skill_id: string;
  owner: string;
  slug: string;
  display_name: string;
  summary: string;
  latest_external_version?: string | null;
  latest_internal_version?: string | null;
  published_version?: string | null;
  content_hash?: string | null;
  status: string;
  installed: boolean;
  installed_version?: string | null;
  installed_content_hash?: string | null;
  installed_versions?: string[];
  update_available: boolean;
  namespace?: string;
  provenance?: CapabilityProvenance | null;
}
