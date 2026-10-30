/**
 * 知识来源按归属分三类：企业知识库 / 个人知识库 / 本机目录。
 *
 * - 企业：由管理员在管理后台配置，部署位置（Manager 托管或企业内网 NAS）只是它的只读属性；
 *   客户端从本机 Agent 的 `GET /api/agent/knowledge-sources` 读到空间数和部署位置，不保存企业 NAS 的地址或令牌。
 * - 个人：原「NAS 知识库」，客户端直连并保存令牌。个人服务只允许 `private` 级；服务端没有这一约束，由客户端拦截。
 * - 本机：本机已注册的目录，Agent 只返回名称和状态，不返回路径。
 * 旧版随包 Agent 没有该接口（404）时，索引记为 null，页面沿用原有显示。
 */
import type { KnowledgeSourceList } from '../../api/agent/knowledgeSources.ts'
import type { KnowledgeBase } from './types'

export type KnowledgeLevel = NonNullable<KnowledgeBase['level']>
/** 个人知识库服务上唯一允许的可见范围。 */
export const PERSONAL_KNOWLEDGE_LEVEL: KnowledgeLevel = 'private'
export const PERSONAL_LEVEL_BLOCKED_MESSAGE = '个人知识库服务只能新建仅本人可见的知识库，企业资料请由管理员放到企业知识库。'

/** 新建、修改个人知识库前调用：团队级和企业级一律拦下，不发请求。 */
export function assertPersonalKnowledgeLevel(level: string): void {
  if (level !== PERSONAL_KNOWLEDGE_LEVEL) throw new Error(PERSONAL_LEVEL_BLOCKED_MESSAGE)
}

/** 个人服务上标为团队级或企业级的已有知识库；仍可正常读取，只提示迁移。 */
export function misplacedPersonalLevel(base: Pick<KnowledgeBase, 'source' | 'level'>): 'team' | 'enterprise' | null {
  if (base.source !== 'local') return null
  return base.level === 'team' || base.level === 'enterprise' ? base.level : null
}

const LEVEL_NAME = { team: '团队级', enterprise: '企业级' } as const
const MIGRATION_HINT = '个人服务只建议保存私人资料，企业资料请由管理员迁移到企业知识库。'

/** 单个知识库的迁移提示，详情页使用。 */
export function personalLevelWarning(base: Pick<KnowledgeBase, 'source' | 'level' | 'name' | 'sourceName'>): string | null {
  const level = misplacedPersonalLevel(base)
  if (!level) return null
  const where = base.sourceName ? `「${base.sourceName}」上的` : '个人服务上的'
  return `${where}「${base.name}」标为${LEVEL_NAME[level]}，但存放在个人服务上。${MIGRATION_HINT}`
}

/** 知识库首页的汇总提示：一个时说清是哪个库，多个时列出名称。 */
export function personalLevelWarningSummary(bases: readonly KnowledgeBase[]): string | null {
  const misplaced = bases.filter((base) => misplacedPersonalLevel(base))
  if (misplaced.length === 0) return null
  if (misplaced.length === 1) return personalLevelWarning(misplaced[0])
  const names = misplaced.map((base) => `「${base.name}」`).join('、')
  return `个人服务上有 ${misplaced.length} 个知识库标为团队级或企业级：${names}。${MIGRATION_HINT}`
}

export type EnterpriseDeployment = 'managed' | 'nas'

export const ENTERPRISE_DEPLOYMENT_LABEL: Record<EnterpriseDeployment, string> = {
  managed: 'Manager 托管',
  nas: '企业内网 NAS',
}

export type EnterpriseSourceSummary =
  | { state: 'ready'; count: number; deployments: EnterpriseDeployment[] }
  | { state: 'unavailable' }

export type LocalSourceSummary =
  | { state: 'ready'; count: number; unavailableCount: number }
  | { state: 'host_unavailable' }

export interface KnowledgeSourceSummary {
  enterprise: EnterpriseSourceSummary
  local: LocalSourceSummary
}

/**
 * 把 Agent 的来源索引汇总成三张来源卡要显示的内容；部署位置去重后按 Manager、NAS 排序。
 * 返回值不是有效索引（缺 data 或 meta）时为 null，与旧版 Agent 一样沿用原有显示。
 */
export function summarizeKnowledgeSources(list: KnowledgeSourceList | null | undefined): KnowledgeSourceSummary | null {
  if (!list || !Array.isArray(list.data) || !list.meta || typeof list.meta !== 'object') return null
  const enterpriseItems = list.data.filter((item) => item.source === 'enterprise')
  const localItems = list.data.filter((item) => item.source === 'local')
  const deployments = (['managed', 'nas'] as const).filter((kind) => enterpriseItems.some((item) => item.deployment === kind))
  return {
    enterprise: list.meta.enterprise === 'ok'
      ? { state: 'ready', count: enterpriseItems.length, deployments }
      : { state: 'unavailable' },
    local: list.meta.local === 'ok'
      ? { state: 'ready', count: localItems.length, unavailableCount: localItems.filter((item) => item.status !== 'ready').length }
      : { state: 'host_unavailable' },
  }
}

/** 企业卡片上的部署标签，例如「部署：企业内网 NAS」；没有空间时不显示。 */
export function enterpriseDeploymentTag(summary: EnterpriseSourceSummary): string | null {
  if (summary.state !== 'ready' || summary.deployments.length === 0) return null
  return `部署：${summary.deployments.map((kind) => ENTERPRISE_DEPLOYMENT_LABEL[kind]).join(' / ')}`
}

export type KnowledgeCategory = 'all' | 'enterprise' | 'local'

/**
 * 知识库列表在某个分类下没有知识库时的说明。企业分类优先用 Agent 索引里的空间数，
 * 让没有直连 Manager 的成员也知道企业知识库已开通、浏览文档还需要连接。
 */
export function knowledgeListEmptyText(
  category: KnowledgeCategory,
  enterprise: { index: EnterpriseSourceSummary | null; connected: boolean },
): string {
  if (category === 'local') return '还没有个人知识库。添加个人知识库服务后，在它那一行新建仅本人可见的知识库。'
  if (category === 'all') return '连接企业知识库或添加个人知识库服务后，知识库会显示在这里。'
  const { index, connected } = enterprise
  if (index?.state === 'ready' && index.count === 0) return '你目前没有可读的企业知识库空间，如需访问请联系管理员。'
  if (connected) return '企业知识库里还没有你可读的空间。'
  if (index?.state === 'ready') return `管理员已为企业开通 ${index.count} 个空间。连接企业知识库后，可以在这里浏览和上传文档。`
  return '连接企业知识库后，企业知识库会显示在这里。'
}
