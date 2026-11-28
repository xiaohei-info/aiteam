/**
 * 历史消息里的附件只有 ref ID 和文件名，本机位置由 Agent 保存
 * （GET /api/agent/conversations/:id/attachment-refs，路径不出本机）。
 * 按 ref ID 取回，所以同一会话发过同名的不同文件也各自打开各自那个。
 */
const cache = new Map<string, Map<string, string>>()

type ListRefs = (conversationId: string) => Promise<ReadonlyArray<{ id: string; path: string }>>

async function refPaths(conversationId: string, list: ListRefs): Promise<Map<string, string>> {
  const cached = cache.get(conversationId)
  if (cached) return cached
  const paths = new Map((await list(conversationId)).map((ref) => [ref.id, ref.path]))
  cache.set(conversationId, paths)
  return paths
}

export async function attachmentRefPath(
  conversationId: string,
  refId: string,
  // 延迟取客户端：这个模块在不加载 Tauri 客户端的环境里也要能单测。
  list: ListRefs = async (id) => (await import('../api/agent')).agentApi.listAttachmentRefs(id),
): Promise<string | undefined> {
  const path = (await refPaths(conversationId, list)).get(refId)
  if (path) return path
  // 刚发出的附件可能还不在缓存里：清掉重取一次再判断。
  cache.delete(conversationId)
  return (await refPaths(conversationId, list)).get(refId)
}

export function forgetAttachmentRefPaths(conversationId?: string): void {
  if (conversationId) cache.delete(conversationId)
  else cache.clear()
}
