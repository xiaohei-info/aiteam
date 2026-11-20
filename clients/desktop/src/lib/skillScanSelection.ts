/**
 * 「添加技能 → 自定义」扫描出多个技能时的选择与按钮文案逻辑。
 * 从 UI 抽出来是为了能直接测：一个文件夹 / 一个 zip 里可能有多个技能，界面要能全选、能只装一部分、
 * 并且在校验不通过的条目上禁止勾选。
 */
import type { CustomSkillScanItem } from '../api/agent/capabilities'

/** 检查时默认勾选所有校验通过的技能（不通过的勾不上，也没有安装意义）。 */
export function defaultPicked(scan: CustomSkillScanItem[]): string[] {
  return scan.filter((item) => item.ok).map((item) => item.root)
}

export function togglePicked(picked: string[], root: string): string[] {
  return picked.includes(root) ? picked.filter((item) => item !== root) : [...picked, root]
}

/** 只有校验通过的条目能进安装清单；重复项按根去重。 */
export function normalizePicked(scan: CustomSkillScanItem[], picked: readonly string[]): string[] {
  const usable = new Set(scan.filter((item) => item.ok).map((item) => item.root))
  return [...new Set(picked)].filter((root) => usable.has(root))
}

export function installButtonLabel(picked: number, busy: boolean): string {
  if (busy) return '正在安装…'
  return picked > 1 ? `安装所选 ${picked} 个` : '安装所选'
}

export function canInstall(picked: number, busy: boolean | null): boolean {
  return busy !== true && picked > 0
}

/** 批量安装有失败时给出一句汇总，方便界面直接显示。 */
export function batchFailureSummary(results: { root: string; ok: boolean; reason?: string }[]): string {
  const failed = results.filter((item) => !item.ok)
  if (failed.length === 0) return ''
  return `已装 ${results.length - failed.length} 个，${failed.length} 个失败：${failed
    .map((item) => `${item.root || '包根'}（${item.reason ?? '失败'}）`)
    .join('；')}`
}
