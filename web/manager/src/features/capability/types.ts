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
