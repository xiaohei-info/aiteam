/**
 * 「添加技能 → 自定义」的请求体组装与来源切换清理。
 *
 * 从 UI 抽出来是为了能直接测：请求体必须只带当前来源需要的字段（否则会出现「zip 源 + 文件夹 roots」
 * 这种不可预期的组合），换来源时上一来源的检查结果必须作废。
 */
import type { CustomSkillImportRequest, CustomSkillSource } from '../api/agent/capabilities'

/** 可能扫出多个技能的「包」来源；只有它们携带 roots。 */
export const PACKAGE_SOURCES: readonly CustomSkillSource[] = ['folder', 'zip']

/** 需要本机路径的来源。 */
export const PATH_SOURCES: readonly CustomSkillSource[] = ['folder', 'zip', 'file']

/** 需要网址的来源（ClawHub 也是网址）。 */
export const URL_SOURCES: readonly CustomSkillSource[] = ['url', 'clawhub']

export interface SkillImportDraft {
  source: CustomSkillSource
  path: string
  text: string
  url: string
  /** 扫描出的技能根；只对文件夹 / zip / 单个 .md 这类「包」来源有意义。 */
  roots: readonly string[]
}

/** 组装导入请求：只带当前来源需要的字段，绝不把别来源的字段混进来。 */
export function buildSkillImportRequest(draft: SkillImportDraft, opts: { preview: boolean }): CustomSkillImportRequest {
  const body: CustomSkillImportRequest = { source: draft.source, preview: opts.preview }
  if (PATH_SOURCES.includes(draft.source) && draft.path) body.path = draft.path
  if (draft.source === 'text' && draft.text) body.skill_md = draft.text
  if (URL_SOURCES.includes(draft.source) && draft.url) body.url = draft.url
  // roots 只跟随「包」来源；单个 .md 文件不是包，换来源后 draft 里也不该留着旧的 roots。
  if (PACKAGE_SOURCES.includes(draft.source) && draft.roots.length > 0) body.roots = [...draft.roots]
  return body
}

/** 切换来源时作废上一来源的检查结果，避免用旧源的 path / roots / 候选配新源提交。 */
export interface SkillImportCheckState {
  preview: unknown
  scan: unknown
  picked: string[]
  clawHub: unknown
}

export function resetCheckState(): SkillImportCheckState {
  return { preview: null, scan: null, picked: [], clawHub: null }
}

/** 把 ClawHub 候选拼成带作者的地址，供成员选定后重新检查。 */
export function clawHubCandidateUrl(owner: string, slug: string): string {
  return `https://clawhub.ai/${owner}/skills/${slug}`
}
