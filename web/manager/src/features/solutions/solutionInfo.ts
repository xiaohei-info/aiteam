import type { RecommendedCapability } from "../experts/types";

const REF = /@\{([^{}\s]+)\}/g;

export function solutionModeLabel(mode: "solo" | "group" | undefined): string {
  return mode === "solo" ? "单人" : "组群";
}

/** 把编排规则里的 `@{id}` 换成 `@名字`；找不到的保留原样并标注，便于发现问题。 */
export function renderRules(rules: string | undefined, names: ReadonlyMap<string, string>): string {
  return (rules ?? "").replace(REF, (_m, id: string) => names.has(id) ? `@${names.get(id)}` : `@${id}（未知成员）`);
}

export function capabilityLabel(item: RecommendedCapability): string {
  const kind = item.kind === "mcp" ? "MCP" : "skill";
  const name = item.display_name && item.display_name !== item.ref ? `${item.display_name}（${item.ref}）` : item.ref;
  return `${kind} · ${name}${item.purpose ? `：${item.purpose}` : ""}`;
}
