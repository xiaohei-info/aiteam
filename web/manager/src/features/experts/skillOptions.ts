import type { SkillCatalog } from "../capability/types";

/** 员工清单里的引用可以是 skill_id 或 skill_id@version；目录身份只认 skill_id。 */
export function skillRefKey(ref: string): string {
  return ref.split("@", 1)[0] ?? ref;
}

export type SkillAvailability = "ready" | "draft" | "invalid" | "disabled";

/** 面向管理员的原因文案，与后端 employee_capability_refs 保持一致（设计 2026-11-22 §4）。 */
export const SKILL_UNAVAILABLE_REASON: Record<Exclude<SkillAvailability, "ready">, string> = {
  draft: "还没完成，暂时不能给员工用",
  invalid: "内容有问题，请重新导入",
  disabled: "已被停用",
};

/** 与 Manager 签发条件一致：停用、草稿、无效的技能不会下发给员工。 */
export function skillAvailability(skill: Pick<SkillCatalog, "binding_policy" | "package_status">): SkillAvailability {
  if (skill.binding_policy === "disabled") return "disabled";
  if (skill.package_status === "draft") return "draft";
  if (skill.package_status === "invalid") return "invalid";
  return "ready";
}

export interface SkillOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * 选择器选项：不可用的置灰并写明原因。员工已经选着的不可用项不置灰，管理员才能取消它。
 */
export function buildSkillOptions(skills: readonly SkillCatalog[], selected: readonly string[]): SkillOption[] {
  const keep = new Set(selected.map(skillRefKey));
  return skills.map((skill) => {
    const base = `${skill.display_name || "未命名技能"} · v${skill.version}`;
    const state = skillAvailability(skill);
    if (state === "ready") return { value: skill.skill_id, label: base };
    return {
      value: skill.skill_id,
      label: `${base}（${SKILL_UNAVAILABLE_REASON[state]}）`,
      disabled: !keep.has(skill.skill_id),
    };
  });
}

/** 员工已有、但企业技能库里已经没有的引用：标「已失效」，让管理员一键去掉。 */
export function danglingSkillRefs(skills: readonly SkillCatalog[], selected: readonly string[]): string[] {
  const known = new Set(skills.map((skill) => skill.skill_id));
  return selected.filter((ref) => !known.has(skillRefKey(ref)));
}
