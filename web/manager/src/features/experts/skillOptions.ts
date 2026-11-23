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

export interface PersonaSkillHint {
  /** 角色设定里写到的技能名。 */
  name: string;
  /** not_on_employee：企业技能库有，但这位员工没有；not_in_catalog：企业技能库里没有。 */
  kind: "not_on_employee" | "not_in_catalog";
  /** 可以直接给员工加上（技能库里有且现在可用）。 */
  addable: boolean;
}

const KEBAB_NAME = /(?<![\w-])[A-Za-z0-9][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+(?![\w-])/g;
const SKILL_WORD = /skill|技能/i;

function mentions(persona: string, skillId: string): boolean {
  const escaped = skillId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(persona);
}

/**
 * 角色设定与员工技能是否对得上（只提示，不拦保存；设计 2026-11-22 §4）：
 * - 写到了企业技能库里的某个技能，但员工没有它；
 * - 同一行写着「skill / 技能」并给出一个连字符命名（如 recruitment-dispatch），但企业技能库里没有它。
 */
export function personaSkillHints(persona: string, skills: readonly SkillCatalog[], selected: readonly string[]): PersonaSkillHint[] {
  const have = new Set(selected.map(skillRefKey));
  const known = new Map(skills.map((skill) => [skill.skill_id, skill]));
  const hints = new Map<string, PersonaSkillHint>();
  for (const skill of skills) {
    if (!have.has(skill.skill_id) && mentions(persona, skill.skill_id)) {
      hints.set(skill.skill_id, { name: skill.skill_id, kind: "not_on_employee", addable: skillAvailability(skill) === "ready" });
    }
  }
  for (const line of persona.split(/\r?\n/)) {
    if (!SKILL_WORD.test(line)) continue;
    for (const name of line.match(KEBAB_NAME) ?? []) {
      if (!known.has(name) && !have.has(name) && !hints.has(name)) hints.set(name, { name, kind: "not_in_catalog", addable: false });
    }
  }
  return [...hints.values()];
}
