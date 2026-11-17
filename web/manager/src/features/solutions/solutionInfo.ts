import type { SkillCatalog } from "../capability/types";
import type { RecommendedCapability, SolutionPackage } from "../experts/types";

const REF = /@\{([^{}\s]+)\}/g;

export function solutionModeLabel(mode: "solo" | "group" | undefined): string {
  return mode === "solo" ? "单人" : "组群";
}

/** 把编排规则里的 `@{id}` 换成 `@名字`；找不到的保留原样并标注，便于发现问题。 */
export function renderRules(rules: string | undefined, names: ReadonlyMap<string, string>): string {
  return (rules ?? "").replace(REF, (_m, id: string) => names.has(id) ? `@${names.get(id)}` : `@${id}（未知成员）`);
}

/** skill 的 ref 是平台 skill_id（UUID），只展示名称；MCP 的 ref 是可读标识，名称后带上。 */
export function capabilityName(item: RecommendedCapability): string {
  if (!item.display_name || item.display_name === item.ref) return item.ref;
  return item.kind === "skill" ? item.display_name : `${item.display_name}（${item.ref}）`;
}

export function capabilityLabel(item: RecommendedCapability): string {
  const kind = item.kind === "mcp" ? "MCP" : "skill";
  return `${kind} · ${capabilityName(item)}${item.purpose ? `：${item.purpose}` : ""}`;
}

export interface CapabilityStatus {
  label: string;
  variant: "success" | "warning" | "neutral";
  /** 管理员可去「技能管理」处理（安装或调整可见范围 / 启用）。 */
  fixable?: boolean;
}

/** 推荐能力在本企业的状态。skill 以本企业技能目录判断（含从技能市场安装的平台 skill）；MCP 装在成员本机，企业端无法判断。 */
export function capabilityStatus(item: RecommendedCapability, skills: readonly SkillCatalog[] | null): CapabilityStatus {
  if (item.kind === "mcp") return { label: "成员需在本机安装", variant: "neutral" };
  if (skills === null) return { label: "无法确认", variant: "neutral" };
  const installed = skills.find((skill) => skill.skill_id === item.ref || skill.config?.source_skill_id === item.ref);
  if (!installed) return { label: "企业缺失", variant: "warning", fixable: true };
  if (installed.binding_policy === "disabled") return { label: "已安装但已停用", variant: "warning", fixable: true };
  // 私有技能只能由管理员绑定给专家，成员在对话中不能自行安装（已装的成员不受影响）。
  if (installed.visibility === "private") return { label: "成员无法自装（私有）", variant: "warning", fixable: true };
  return { label: "企业已具备", variant: "success" };
}

/** 目录卡片上的一句话摘要：成员数、群主、推荐能力数（含缺失的 skill 数）。 */
export function solutionSummary(solution: SolutionPackage, skills: readonly SkillCatalog[] | null): string {
  const experts = (solution.experts ?? []).filter((expert) => expert.enabled !== false);
  const coordinator = experts.find((expert) => expert.template_id === solution.coordinator_template_id);
  const capabilities = solution.recommended_capabilities ?? [];
  const missing = capabilities.filter((item) => capabilityStatus(item, skills).label === "企业缺失").length;
  return [
    `${experts.length} 位专家`,
    solution.mode === "solo" ? "私聊使用" : coordinator ? `群主 ${coordinator.display_name}` : "",
    capabilities.length ? `推荐能力 ${capabilities.length} 项${missing ? `（${missing} 项 skill 企业缺失）` : ""}` : "",
  ].filter(Boolean).join(" · ");
}
