/**
 * 知识来源索引:本机 Agent 只读列出企业 / 个人 / 本机三类来源,不缓存、不上传。
 *
 *   GET /api/agent/knowledge-sources?source=enterprise|personal|local
 *
 * - enterprise:Agent 用当前成员的登录身份转发到 Manager,只返回部署位置,不含 NAS 地址或凭据。
 * - personal:个人知识服务由客户端直连、令牌只在客户端,接口恒为空,meta.personal = client_held。
 * - local:本机已注册目录,不含绝对路径。
 * 不传 source 时 Manager 不可用只把 meta.enterprise 记为 unavailable。
 * 旧版随包 Agent 没有该路由,返回 404 not_found;调用方据此沿用原有显示。
 */
import type { ServiceApiClient } from './client'

export type KnowledgeSourceKind = 'enterprise' | 'personal' | 'local'
export type KnowledgeSourceDeployment = 'managed' | 'nas' | 'this_device'

export interface KnowledgeSourceItem {
  source: KnowledgeSourceKind
  id: string
  name: string
  deployment: KnowledgeSourceDeployment
  /** 企业为 ready;本机为目录检查结果(ready、authorization_unavailable 等)。 */
  status: string
}

export interface KnowledgeSourcesMeta {
  enterprise: 'ok' | 'unavailable' | 'not_requested'
  personal: 'client_held' | 'not_requested'
  local: 'ok' | 'host_unavailable' | 'not_requested'
}

export interface KnowledgeSourceList {
  data: KnowledgeSourceItem[]
  meta: KnowledgeSourcesMeta
}

export const KNOWLEDGE_SOURCES_PATH = '/api/agent/knowledge-sources'

export function listKnowledgeSources(
  client: ServiceApiClient,
  source?: KnowledgeSourceKind,
  signal?: AbortSignal,
): Promise<KnowledgeSourceList> {
  return client.request<KnowledgeSourceList>({
    method: 'GET',
    path: KNOWLEDGE_SOURCES_PATH,
    query: { source },
    raw: true,
    signal,
  })
}
