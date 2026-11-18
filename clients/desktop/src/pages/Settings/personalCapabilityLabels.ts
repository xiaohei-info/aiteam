import type { LocalCapability, LocalCapabilityKind } from '../../api/agent/types'

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
