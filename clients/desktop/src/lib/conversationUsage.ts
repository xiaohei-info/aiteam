import type { WorkHistoryEnvelope, WorkRecord } from '../api/agent/observations.types'

export interface ConversationUsage { tokens: number | null; outcome: WorkRecord['outcome'] | null }
type ReadWorkPage = (before?: string) => Promise<WorkHistoryEnvelope>

/** Sum the work usage on record across every page, excluding other conversations; null when there is none. */
export async function readConversationUsage(conversationId: string, readPage: ReadWorkPage): Promise<ConversationUsage> {
  const records = new Map<string, WorkRecord>()
  const cursors = new Set<string>()
  let before: string | undefined
  do {
    const page = await readPage(before)
    for (const record of page.data) {
      if (record.conversation_id === conversationId && !records.has(record.id)) records.set(record.id, record)
    }
    if (!page.page.has_more) break
    const next = page.page.next_cursor
    if (!next || cursors.has(next)) throw new Error('工作记录分页无效')
    cursors.add(next); before = next
  } while (before)
  const work = [...records.values()]
  // 一次运行没有用量（例如中途被结束）不应让整个会话显示 0，只累加有记录的运行。
  const measured = work.flatMap(record => record.usage ? [record.usage.token_total] : [])
  return {
    tokens: measured.length > 0 ? measured.reduce((sum, tokens) => sum + tokens, 0) : null,
    outcome: work[0]?.outcome ?? null,
  }
}
