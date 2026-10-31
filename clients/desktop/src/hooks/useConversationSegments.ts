import { useCallback, useEffect, useMemo, useState } from 'react'
import { agentApi, AgentApiError } from '../api/agent'
import type { ContextSegment } from '../api/agent/types'
import { segmentsByResetId, upsertSegment } from '../lib/contextOutcome'

/**
 * 会话各上下文段落的结果评估,供"新上下文"分隔线按 reset_id 合并显示。
 * 旧版随包 Agent 没有该接口(404)时按空列表处理,分隔线一律显示未评估。
 */
export function useConversationSegments(conversationId: string | null, refreshKey: number) {
  const [segments, setSegments] = useState<ContextSegment[]>([])
  const [attempt, setAttempt] = useState(0)
  // 服务端已返回 segment_edit_window_closed 的段落,本机时钟偏差时也不再允许修改。
  const [closedIds, setClosedIds] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => { setSegments([]); setClosedIds(new Set()) }, [conversationId])
  useEffect(() => {
    if (!conversationId || conversationId.startsWith('emp_')) return
    let cancelled = false
    agentApi.listConversationSegments(conversationId)
      .then((list) => { if (!cancelled) setSegments(Array.isArray(list) ? list : []) })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof AgentApiError && err.status === 404) setSegments([])
        else console.error('[chat] load context segments failed:', err)
      })
    return () => { cancelled = true }
  }, [conversationId, refreshKey, attempt])

  const upsert = useCallback((segment: ContextSegment) => setSegments((current) => upsertSegment(current, segment)), [])
  const reload = useCallback(() => setAttempt((count) => count + 1), [])
  const markClosed = useCallback((segmentId: string) => setClosedIds((current) => new Set([...current, segmentId])), [])
  const byResetId = useMemo(() => segmentsByResetId(segments), [segments])
  return { byResetId, closedIds, upsert, reload, markClosed }
}
