/**
 * 桌面网关 Agent 会在私聊提示末尾追加授权目录检索结果（FredServer
 * services/gateway-local-context.ts 的 `<aiteam-local-context>` 围栏块）。
 * 它是给模型的参考数据而不是用户输入：展示时去掉，只保留一个标记。
 */
const OPEN = '\n\n<aiteam-local-context v="1" action="'
const CLOSE = '</aiteam-local-context>'

export type LocalContextAction = 'search' | 'list'

export function splitLocalContext(text: string): { text: string; localContext?: LocalContextAction } {
  if (!text.trimEnd().endsWith(CLOSE)) return { text }
  const start = text.lastIndexOf(OPEN)
  if (start < 0) return { text }
  const action = /^(search|list)">/u.exec(text.slice(start + OPEN.length))?.[1]
  if (action !== 'search' && action !== 'list') return { text }
  return { text: text.slice(0, start), localContext: action }
}
