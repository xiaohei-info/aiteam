import { useEffect, useRef, useState } from 'react'
import { CircleAlert, RotateCw } from 'lucide-react'
import './ChatTools.css'
import { agentApi } from '../../api/agent'
import { readConversationUsage, type ConversationUsage } from '../../lib/conversationUsage'
import type { ConversationContextOut } from '../../api/agent/types'

interface ConversationStatusProps {
  conversationId: string
  generating: boolean
  /** 员工已不可对话（暂停、下架等）：不再查询上下文和消耗，也不显示状态栏。 */
  unavailable?: boolean
}

const executionStates = [
  { key: 'ready', label: '就绪' },
  { key: 'generating', label: '正在生成' },
  { key: 'active', label: '执行中' },
  { key: 'succeeded', label: '已完成' },
  { key: 'error', label: '执行失败' },
  { key: 'aborted', label: '已停止' },
  { key: 'unknown', label: '状态待同步' },
] as const

function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  const units = [
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'K' },
  ]
  const unit = units.find(({ threshold }) => tokens >= threshold)
  if (!unit) return tokens.toLocaleString()
  const scaled = tokens / unit.threshold
  const rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10
  return `${rounded}${unit.suffix}`
}

export function ConversationStatus({ conversationId, generating, unavailable = false }: ConversationStatusProps) {
  const lastRecordedUsage = useRef<{ conversationId: string; tokens: number } | null>(null)
  const [usage, setUsage] = useState<ConversationUsage>({ tokens: null, outcome: null })
  const [usageError, setUsageError] = useState('')
  const [context, setContext] = useState<ConversationContextOut | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  // 点「重试」后到这次读取结束前禁用按钮，避免连点。
  const [retrying, setRetrying] = useState(false)
  // Only a different conversation invalidates the displayed totals. Refreshes
  // triggered by sending, completion, or retry keep the last known values.
  useEffect(() => {
    lastRecordedUsage.current = null
    setContext(null); setError(''); setUsage({ tokens: null, outcome: null }); setUsageError('')
  }, [conversationId])
  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    let pending = false
    if (conversationId.startsWith('emp_') || unavailable) return
    const refresh = async () => {
      if (pending) return
      pending = true
      const [contextResult, usageResult] = await Promise.allSettled([
        agentApi.getConversationContext(conversationId),
        readConversationUsage(conversationId, before => agentApi.getWorkRecords({ before, limit: 100 }, controller.signal)),
      ])
      if (!cancelled) {
        if (contextResult.status === 'fulfilled') { setContext(contextResult.value); setError('') }
        else setError('上下文用量读取失败')
        if (usageResult.status === 'fulfilled') {
          if (usageResult.value.tokens !== null) lastRecordedUsage.current = { conversationId, tokens: usageResult.value.tokens }
          setUsage(usageResult.value); setUsageError('')
        }
        else setUsageError('消耗读取失败')
        setRetrying(false)
      }
      pending = false
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15000)
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer) }
  }, [conversationId, generating, attempt, unavailable])
  const hasContextUsage = context?.used_tokens != null && context.context_window > 0
  const percentage = hasContextUsage
    ? context.percentage ?? (context.used_tokens! / context.context_window * 100)
    : null
  const usageLabel = hasContextUsage
    ? `上下文: ${percentage!.toFixed(0)}%\u00a0\u00a0${(context.used_tokens! / 1000).toFixed(1)}K/${(context.context_window / 1000).toFixed(1)}K`
    : '上下文: 0%\u00a0\u00a00/0'

  // A running work record may not have usage yet, even just after completion.
  const displayedTokens = usage.tokens ?? (
    lastRecordedUsage.current?.conversationId === conversationId ? lastRecordedUsage.current.tokens : null
  )
  const actualState = generating || context?.prompting ? 'generating' : usage.outcome ?? 'ready'
  const displayedState = executionStates.find(state => state.key === actualState)!
  if (unavailable) return null

  return <div className="chat-conversation-status chat-usage-status">
    {(error || usageError) && <div className="chat-status-error" role="alert">
      <CircleAlert className="chat-status-error-icon" size={13} strokeWidth={2} aria-hidden="true" />
      <span>{[error, usageError].filter(Boolean).join('；')}</span>
      <button
        type="button"
        className="chat-status-retry"
        disabled={retrying}
        onClick={() => { setRetrying(true); setAttempt(value => value + 1) }}
      >
        <RotateCw className={retrying ? 'is-spinning' : undefined} size={12} strokeWidth={2} aria-hidden="true" />
        {retrying ? '重试中' : '重试'}
      </button>
    </div>}
    <div className="chat-status-line chat-status-footer">
      <span className="chat-context-usage" title={hasContextUsage ? `已使用 ${context.used_tokens!.toLocaleString()} / ${context.context_window.toLocaleString()} Token` : undefined} aria-label={usageLabel}>{usageLabel}</span>
      <div className="chat-execution-usage" role="status">
        <span className={`chat-execution-state ${displayedState.key}`}>{displayedState.label}</span>
        <span className="chat-context-usage">累计消耗: {displayedTokens === null ? '0 tokens' : `${formatTokenCount(displayedTokens)} tokens`}</span>
      </div>
    </div>
  </div>
}
