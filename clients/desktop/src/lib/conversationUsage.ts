import type { WorkHistoryEnvelope, WorkRecord } from '../api/agent/observations.types'

export interface ConversationUsage { tokens: number | null; outcome: WorkRecord['outcome'] | null }
type ReadWorkPage = (before?: string) => Promise<WorkHistoryEnvelope>

/** Sum authoritative work usage across every page, excluding other conversations. */
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
  return {
    tokens: work.length > 0 && work.every(record => record.usage != null)
      ? work.reduce((sum, record) => sum + record.usage!.token_total, 0) : null,
    outcome: work[0]?.outcome ?? null,
  }
}
