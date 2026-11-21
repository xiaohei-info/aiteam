/**
 * Who made a skill / MCP and where it came from (design 2026-11-20「技能MCP命名空间出处与更新提示」§4.1).
 * Same rules as `server/shared/capability_namespace.py`; the server computes, the consoles only display.
 */
export interface CapabilityProvenance {
  kind: "clawhub" | "url" | "platform";
  /** e.g. 「ClawHub steipete/weather」「github.com/acme/skills」「taiyim/weather」 */
  label: string;
  url?: string;
  /** upstream version we edited */
  version?: string;
  /** false: taken unchanged (来自); true: we changed it (改自) */
  edited: boolean;
}

/** `taiyim/weather`; content taken unchanged from another platform has no namespace. */
export function capabilityTitle(namespace: string | null | undefined, name: string): string {
  return namespace ? `${namespace}/${name}` : name;
}

/** 「来自 ClawHub steipete/weather」/「改自 taiyim/weather v8c2d…」, or "" for our own content. */
export function provenanceText(provenance: CapabilityProvenance | null | undefined): string {
  if (!provenance?.label) return "";
  if (!provenance.edited) return `来自 ${provenance.label}`;
  return `改自 ${provenance.label}${provenance.version ? ` v${provenance.version}` : ""}`;
}
