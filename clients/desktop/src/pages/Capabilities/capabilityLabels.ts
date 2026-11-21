import type { CapabilityProvenance, InstallableSkill, LocalCapability, LocalCapabilityKind } from '../../api/agent/types'

/** `approved_by` of installs approved by the member's auto-install grant (Agent AUTO_INSTALL_APPROVER). */
export const AUTO_INSTALL_APPROVER = 'policy:auto-install'

/** 已装个人能力的来源说明（设计 §11.3）。 */
export function capabilitySourceLabel(item: Pick<LocalCapability, 'kind' | 'source'>): string {
  if (item.source === 'platform_catalog') return item.kind === 'skill' ? '平台技能市场' : '平台 MCP 目录'
  if (item.source === 'enterprise_catalog') return item.kind === 'skill' ? '企业自建技能' : '企业自建 MCP'
  // ClawHub 这类有明确平台的来源显示平台名；本地导入（文件夹 / zip / .md / 粘贴）显示「自定义」。
  if (item.source === 'clawhub_catalog') return 'ClawHub'
  if (item.source === 'user_import') return '自定义'
  return '手动地址'
}

/**
 * 来源徽标的视觉语气。同一类来源共用一种颜色，避免满屏都是灰底小字。
 * - `brand`：平台/市场来源（有明确发布方）
 * - `neutral`：企业或本地导入
 * - `muted`：手动地址
 */
export type SourceTone = 'brand' | 'neutral' | 'muted'

export function capabilitySourceTone(item: Pick<LocalCapability, 'kind' | 'source'>): SourceTone {
  if (item.source === 'platform_catalog' || item.source === 'clawhub_catalog') return 'brand'
  if (item.source === 'enterprise_catalog') return 'neutral'
  if (item.source === 'user_import') return 'neutral'
  return 'muted'
}

/** 本机导入的技能（含 ClawHub 下载后落在本机的）可以在文件管理器里显示目录。 */
export function hasLocalDirectory(item: Pick<LocalCapability, 'kind' | 'source'>): boolean {
  return item.kind === 'skill' && (item.source === 'user_import' || item.source === 'clawhub_catalog')
}

export function isAutoInstalled(item: Pick<LocalCapability, 'approved_by'>): boolean {
  return item.approved_by === AUTO_INSTALL_APPROVER
}

export function autoInstallKindLabel(kind: LocalCapabilityKind): string {
  return kind === 'skill' ? '从平台技能市场安装技能时直接安装' : '从平台 MCP 目录安装 MCP 时直接安装'
}

/**
 * 本机导入技能的文件完整性（自定义技能导入 2026-11-18 §3.1；ClawHub 接入 2026-11-19 一并覆盖）。
 * 旧版 Agent 不返回时为 null。
 */
export function customSkillIntegrityLabel(item: Pick<LocalCapability, 'source' | 'integrity'>): { text: string; attention: boolean } | null {
  if ((item.source !== 'user_import' && item.source !== 'clawhub_catalog') || !item.integrity) return null
  return item.integrity === 'modified' ? { text: '文件被改动，已停用', attention: true } : { text: '文件未改动', attention: false }
}

/** 已装 MCP 的鉴权状态（MCP 鉴权 2026-11-18 §3.6）；技能或旧版 Agent 不返回时为 null。 */
export function mcpAuthStatusLabel(item: Pick<LocalCapability, 'kind' | 'auth_status' | 'auth_expires_at'>): { text: string; attention: boolean } | null {
  if (item.kind !== 'mcp' || !item.auth_status) return null
  switch (item.auth_status) {
    case 'none': return { text: '无需登录', attention: false }
    case 'signed_in': {
      const at = item.auth_expires_at ? Date.parse(item.auth_expires_at) : NaN
      return { text: Number.isFinite(at) ? `已登录（到期 ${formatExpiry(at)}）` : '已登录', attention: false }
    }
    case 'needs_login': return { text: '需要重新登录', attention: true }
    case 'token_set': return { text: '已填令牌', attention: false }
    case 'needs_token': return { text: '需要填写令牌', attention: true }
  }
}

function formatExpiry(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 完整名称（设计「技能MCP命名空间出处与更新提示」§4.1）：taiyim/weather、太一科技/周报；原样取自其他平台的不带前缀。
 * 与 web/shared/src/skills/namespace.ts 同一规则（桌面端不引用 web 源码，这里各存一份）。
 */
export function capabilityTitle(namespace: string | null | undefined, name: string): string {
  return namespace ? `${namespace}/${name}` : name
}

/** 「来自 ClawHub steipete/weather」/「改自 taiyim/weather v8c2d」；自己的内容为空。 */
export function provenanceText(provenance: CapabilityProvenance | null | undefined): string {
  if (!provenance?.label) return ''
  if (!provenance.edited) return `来自 ${provenance.label}`
  return `改自 ${provenance.label}${provenance.version ? ` v${provenance.version}` : ''}`
}

/** 「添加技能」列表里一项企业可装技能对本人的状态：未装 / 已装同版本 / 已装旧版本（可更新）/ 本机已有同名的其他技能（可替换）。 */
export type InstallableSkillState = { action: 'install' } | { action: 'installed' } | { action: 'upgrade'; from: string } | { action: 'conflict'; name: string }

export function installableSkillState(skill: Pick<InstallableSkill, 'skill_id' | 'version' | 'state' | 'local_display_name' | 'local_version' | 'local_ref'>, installed: Pick<LocalCapability, 'kind' | 'ref' | 'version'>[]): InstallableSkillState {
  // 新版 Agent 自己算好了（按 SKILL.md 同名判断）；旧版 Agent 退回按标识比对。
  if (skill.state === 'installed') return { action: 'installed' }
  if (skill.state === 'update') return { action: 'upgrade', from: skill.local_version ?? '' }
  if (skill.state === 'conflict') return { action: 'conflict', name: skill.local_display_name || skill.local_ref || '' }
  if (skill.state === 'install') return { action: 'install' }
  const current = installed.find((item) => item.kind === 'skill' && item.ref === skill.skill_id)
  if (!current) return { action: 'install' }
  return current.version === skill.version ? { action: 'installed' } : { action: 'upgrade', from: current.version ?? '' }
}

/**
 * 「替换安装」前的确认文案：写清被移除的是本机哪一个、从哪来的。
 * 自己导入（含 ClawHub 下到本机）的技能可能改过，替换会连文件一起删掉，单独提醒。
 */
export function replaceConfirmText(
  skill: Pick<InstallableSkill, 'display_name' | 'skill_id' | 'namespace' | 'local_ref' | 'local_display_name'>,
  installed: Pick<LocalCapability, 'kind' | 'ref' | 'display_name' | 'source'>[],
): string {
  const local = installed.find((item) => item.kind === 'skill' && item.ref === skill.local_ref)
  const name = skill.local_display_name || local?.display_name || skill.local_ref || '同名技能'
  const from = local ? `（来源：${capabilitySourceLabel(local)}）` : ''
  const own = local && hasLocalDirectory(local) ? '这是你自己导入的技能，你改过的内容也会一起删掉，无法恢复。' : ''
  return `将移除本机的「${name}」${from}及它的全部文件，改装「${capabilityTitle(skill.namespace, skill.display_name || skill.skill_id)}」。${own}`
}
