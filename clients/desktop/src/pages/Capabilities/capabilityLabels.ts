import type { InstallableSkill, LocalCapability, LocalCapabilityKind } from '../../api/agent/types'

/** `approved_by` of installs approved by the member's auto-install grant (Agent AUTO_INSTALL_APPROVER). */
export const AUTO_INSTALL_APPROVER = 'policy:auto-install'

/** 已装个人能力的来源说明（设计 §11.3）。 */
export function capabilitySourceLabel(item: Pick<LocalCapability, 'kind' | 'source'>): string {
  if (item.source === 'platform_catalog') return item.kind === 'skill' ? '平台技能市场' : '平台 MCP 目录'
  if (item.source === 'enterprise_catalog') return '企业自建技能'
  return '手动地址'
}

export function isAutoInstalled(item: Pick<LocalCapability, 'approved_by'>): boolean {
  return item.approved_by === AUTO_INSTALL_APPROVER
}

export function autoInstallKindLabel(kind: LocalCapabilityKind): string {
  return kind === 'skill' ? '从平台技能市场安装技能时直接安装' : '从平台 MCP 目录安装 MCP 时直接安装'
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

/** 「添加技能」列表里一项企业可装技能对本人的状态：未装 / 已装同版本 / 已装其他版本（可换成目录当前版本）。 */
export type InstallableSkillState = { action: 'install' } | { action: 'installed' } | { action: 'upgrade'; from: string }

export function installableSkillState(skill: Pick<InstallableSkill, 'skill_id' | 'version'>, installed: Pick<LocalCapability, 'kind' | 'ref' | 'version'>[]): InstallableSkillState {
  const current = installed.find((item) => item.kind === 'skill' && item.ref === skill.skill_id)
  if (!current) return { action: 'install' }
  return current.version === skill.version ? { action: 'installed' } : { action: 'upgrade', from: current.version ?? '' }
}
