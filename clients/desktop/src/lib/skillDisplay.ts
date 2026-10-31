/**
 * 员工技能展示名：优先用 Agent 服务从已验签技能包读出的 display_name，
 * 取不到时回退到去掉版本号的技能 ID（research@v1 → research），不生成占位名称。
 */
export interface SkillDetail {
  ref: string
  display_name?: string | null
}

export function skillDisplayName(ref: string, details?: readonly SkillDetail[] | null): string {
  const name = details?.find((item) => item.ref === ref)?.display_name?.trim()
  if (name) return name
  const at = ref.lastIndexOf('@')
  return at > 0 ? ref.slice(0, at) : ref
}

export function skillDisplayNames(skills?: readonly string[] | null, details?: readonly SkillDetail[] | null): string[] {
  return [...new Set((skills ?? []).map((ref) => skillDisplayName(ref, details)))]
}
