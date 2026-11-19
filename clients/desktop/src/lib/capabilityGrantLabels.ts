/** 能力授权的展示辅助（纯逻辑，便于直接测）。 */

/** 来源标签：设置页把内部来源标记翻成用户能看懂的词。 */
export function capabilityGrantSourceLabel(source: string): string {
  if (source === 'platform_catalog') return '平台目录'
  if (source === 'enterprise_catalog') return '企业目录'
  if (source === 'clawhub_catalog') return 'ClawHub'
  return '本机导入'
}

export type CapabilityGrantLike = {
  conversation_id: string
  kind: string
  ref: string
  source: string
}

/** 设置页按会话分组；一次撤销是整会话的。 */
export function groupCapabilityGrants<T extends CapabilityGrantLike>(grants: readonly T[]): Map<string, T[]> {
  return grants.reduce<Map<string, T[]>>((map, grant) => {
    const list = map.get(grant.conversation_id) ?? []
    list.push(grant)
    map.set(grant.conversation_id, list)
    return map
  }, new Map())
}
