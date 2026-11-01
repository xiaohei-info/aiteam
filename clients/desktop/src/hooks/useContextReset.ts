import { useCallback, useEffect, useRef, useState } from 'react'
import { agentApi, AgentApiError } from '../api/agent'
import type { ContextResetResult, ContextSegmentEvaluation } from '../api/agent/types'
import { contextResetFinishedNotice, contextResetRequest, isOutcomeUnsupportedError } from '../lib/contextOutcome'
import type { ContextResetNotice } from '../lib/contextResetMemory'

/** 'outcome' 来自「解决了吗」气泡(带评估);'plain' 来自工具栏(不评估)。 */
export type ContextResetSource = 'outcome' | 'plain'

export interface ContextResetNoticeState extends ContextResetNotice {
  id: number
}

export interface PendingContextReset {
  result: ContextResetResult
  source: ContextResetSource
  // 确认重试时须原样再带一次;不评估时为 null。
  evaluation: ContextSegmentEvaluation | null
}

export type ContextResetOutcome = 'done' | 'confirm' | 'failed'

function resetErrorText(err: unknown): string {
  if (err instanceof AgentApiError && err.status === 409) return '正在生成回复，请等本轮结束后再开启新上下文。'
  if (err instanceof AgentApiError && err.status === 404) return '会话不存在或已被删除。'
  return '开启新上下文失败，请稍后重试。'
}

/**
 * 开启新上下文的请求流程,气泡和工具栏共用一份状态,避免两处同时重置:
 * 记忆保存失败时等用户确认、旧版 Agent 不认识评估字段时去掉评估重发、结束后的顶部提示。
 * completedCount 在每次重置完成后递增,气泡据此收起。
 */
export function useContextReset(conversationId: string, onReset: (result: ContextResetResult) => void) {
  const [resetting, setResetting] = useState<ContextResetSource | null>(null)
  const [notice, setNotice] = useState<ContextResetNoticeState | null>(null)
  const [pending, setPending] = useState<PendingContextReset | null>(null)
  const [completedCount, setCompletedCount] = useState(0)
  // 旧版随包 Agent 不认识评估字段:本会话后续请求直接只做重置。
  const outcomeUnsupportedRef = useRef(false)
  const onResetRef = useRef(onReset)
  useEffect(() => { onResetRef.current = onReset }, [onReset])

  useEffect(() => {
    setPending(null)
    outcomeUnsupportedRef.current = false
  }, [conversationId])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 3200)
    return () => window.clearTimeout(timer)
  }, [notice])

  const run = useCallback(async (
    source: ContextResetSource,
    evaluation: ContextSegmentEvaluation | null,
    proceed: boolean,
  ): Promise<ContextResetOutcome> => {
    setResetting(source)
    try {
      let recorded = evaluation !== null && !outcomeUnsupportedRef.current
      let result: ContextResetResult
      try {
        result = await agentApi.resetConversationContext(conversationId, contextResetRequest(recorded ? evaluation : null, proceed))
      } catch (err) {
        if (!recorded || !isOutcomeUnsupportedError(err)) throw err
        outcomeUnsupportedRef.current = true
        recorded = false
        result = await agentApi.resetConversationContext(conversationId, contextResetRequest(null, proceed))
      }
      // 群聊可能部分参与者已重置,先刷新分隔线,再询问剩下的参与者。
      if (result.reset && !result.already_reset) onResetRef.current(result)
      if (result.confirmation_required) {
        setPending({ result, source, evaluation })
        return 'confirm'
      }
      setPending(null)
      setCompletedCount((count) => count + 1)
      const resetNotice = contextResetFinishedNotice(result, evaluation !== null, recorded)
      setNotice(resetNotice ? { id: Date.now(), ...resetNotice } : null)
      return 'done'
    } catch (err) {
      console.error('[chat] context reset failed:', err)
      setPending(null)
      setNotice({ id: Date.now(), tone: 'warn', text: resetErrorText(err) })
      return 'failed'
    } finally {
      setResetting(null)
    }
  }, [conversationId])

  const confirmPending = useCallback(() => {
    if (pending) void run(pending.source, pending.evaluation, true)
  }, [pending, run])
  const cancelPending = useCallback(() => setPending(null), [])

  return { resetting, notice, pending, completedCount, run, confirmPending, cancelPending }
}

export type ContextResetController = ReturnType<typeof useContextReset>
