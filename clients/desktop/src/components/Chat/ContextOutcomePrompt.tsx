import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, CircleCheck, RotateCcw, X } from 'lucide-react'
import { agentApi, AgentApiError } from '../../api/agent'
import type { ContextResetResult } from '../../api/agent/types'
import type { Message } from '../../stores/chat'
import { confirmationReasonText } from '../../lib/contextResetMemory'
import {
  contextOutcomeNotice, contextResetRequest, emptyOutcomeDraft, isOutcomeUnsupportedError, MAX_OUTCOME_NOTE_CHARS,
  OUTCOME_REASONS, outcomeEvaluation, shouldShowOutcomePrompt, type ContextOutcomeDraft,
} from '../../lib/contextOutcome'
import { ChatDialog } from './ChatDialog'
import { ContextResetExplainDialog } from './ContextResetExplainDialog'

interface ContextOutcomePromptProps {
  conversationId: string
  // 当前上下文段的消息(最后一条分隔线之后)。
  segment: ReadonlyArray<Pick<Message, 'role' | '_pending'>>
  // 本轮回复生成中(含排队消息)时不出现,结束后才能结束本段。
  generating: boolean
  onReset: (result: ContextResetResult) => void
}

interface ResetNotice {
  id: number
  tone: 'ok' | 'warn'
  text: string
}

function resetErrorText(err: unknown): string {
  if (err instanceof AgentApiError && err.status === 409) return '正在生成回复，请等本轮结束后再开启新上下文。'
  if (err instanceof AgentApiError && err.status === 404) return '会话不存在或已被删除。'
  return '开启新上下文失败，请稍后重试。'
}

/** 「未解决」的原因标签、备注和待跟进;提示条和修改评估共用。 */
export function OutcomeReasonFields({ draft, disabled, onChange }: {
  draft: ContextOutcomeDraft
  disabled?: boolean
  onChange: (draft: ContextOutcomeDraft) => void
}) {
  const toggleReason = (reason: ContextOutcomeDraft['reasons'][number]) => onChange({
    ...draft,
    reasons: draft.reasons.includes(reason) ? draft.reasons.filter((item) => item !== reason) : [...draft.reasons, reason],
  })
  return (
    <div className="chat-outcome-fields">
      <div className="chat-outcome-reasons" role="group" aria-label="未解决原因（可选）">
        {OUTCOME_REASONS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className="chat-outcome-chip"
            aria-pressed={draft.reasons.includes(value)}
            disabled={disabled}
            onClick={() => toggleReason(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <textarea
        className="chat-outcome-note"
        aria-label="备注（选填）"
        placeholder="备注（选填）"
        rows={2}
        maxLength={MAX_OUTCOME_NOTE_CHARS}
        value={draft.note}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, note: event.target.value })}
      />
      <label className="chat-outcome-follow-up">
        <input
          type="checkbox"
          checked={draft.followUp}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, followUp: event.target.checked })}
        />
        <span>保留为待跟进事项</span>
      </label>
    </div>
  )
}

/**
 * 回复结束后输入框上方的「解决了吗」提示条,是开启新上下文的唯一入口:
 * 点「已解决」或「未解决」都会结束本段、记录结果并开启新上下文。关掉后到下一次回复结束前不再出现。
 */
export function ContextOutcomePrompt({ conversationId, segment, generating, onReset }: ContextOutcomePromptProps) {
  const [dismissed, setDismissed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<ContextOutcomeDraft>(() => emptyOutcomeDraft('unresolved'))
  const [resetting, setResetting] = useState(false)
  const [notice, setNotice] = useState<ResetNotice | null>(null)
  const [explaining, setExplaining] = useState(false)
  // 记忆保存临时失败、上下文仍保留时等待用户确认;确认重试要带同一份评估。
  const [pending, setPending] = useState<{ result: ContextResetResult; draft: ContextOutcomeDraft } | null>(null)
  // 旧版随包 Agent 不认识评估字段:本会话后续请求直接只做重置。
  const outcomeUnsupportedRef = useRef(false)

  useEffect(() => {
    setDismissed(false); setExpanded(false); setDraft(emptyOutcomeDraft('unresolved')); setPending(null)
    outcomeUnsupportedRef.current = false
  }, [conversationId])
  // 新一轮回复开始:它结束后提示条重新出现。
  useEffect(() => {
    if (generating) setDismissed(false)
  }, [generating])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 3200)
    return () => window.clearTimeout(timer)
  }, [notice])

  const run = async (submitted: ContextOutcomeDraft, proceed: boolean) => {
    setResetting(true)
    const evaluation = outcomeEvaluation(submitted)
    try {
      let recorded = !outcomeUnsupportedRef.current
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
      if (result.reset && !result.already_reset) onReset(result)
      if (result.confirmation_required) {
        setPending({ result, draft: submitted })
        return
      }
      setPending(null)
      setDismissed(true)
      setExpanded(false)
      setDraft(emptyOutcomeDraft('unresolved'))
      const resetNotice = contextOutcomeNotice(result, recorded)
      setNotice(resetNotice ? { id: Date.now(), ...resetNotice } : null)
    } catch (err) {
      console.error('[chat] context reset failed:', err)
      setPending(null)
      setNotice({ id: Date.now(), tone: 'warn', text: resetErrorText(err) })
    } finally {
      setResetting(false)
    }
  }

  const visible = resetting || shouldShowOutcomePrompt({ segment, generating, dismissed })
  const busy = resetting || generating

  return (
    <>
      {visible && (
        <div className="chat-outcome-prompt" role="region" aria-label="这个问题解决了吗">
          <div className="chat-outcome-prompt-row">
            <span className="chat-outcome-prompt-question">这个问题解决了吗？</span>
            <button
              type="button"
              className="chat-outcome-btn resolved"
              disabled={busy}
              title="记为已解决，并开启新上下文"
              onClick={() => { void run(emptyOutcomeDraft('resolved'), false) }}
            >
              <CircleCheck size={14} strokeWidth={2} aria-hidden="true" />
              <span>已解决</span>
            </button>
            <button
              type="button"
              className="chat-outcome-btn unresolved"
              disabled={busy}
              aria-expanded={expanded}
              title="选择原因（可跳过），记为未解决并开启新上下文"
              onClick={() => setExpanded((open) => !open)}
            >
              <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
              <span>未解决</span>
            </button>
            {/* 感叹号跟在提示语后面，窄列里随提示语一起换到第二行。 */}
            <span className="chat-outcome-prompt-hint-group">
              <span className="chat-outcome-prompt-hint" title={resetting ? undefined : '选择后将开启新上下文，历史消息保留'}>
                {resetting ? '正在开启新上下文…' : '选择后将开启新上下文，历史消息保留'}
              </span>
              <button
                type="button"
                className="chat-outcome-prompt-info"
                aria-label="开启新上下文是什么意思"
                aria-haspopup="dialog"
                title="开启新上下文是什么意思？"
                onClick={() => setExplaining(true)}
              >
                <CircleAlert size={14} aria-hidden="true" />
              </button>
            </span>
            <button
              type="button"
              className="chat-outcome-prompt-close"
              aria-label="关闭提示"
              title="关闭，下次回复结束后再提示"
              disabled={resetting}
              onClick={() => { setDismissed(true); setExpanded(false) }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          {expanded && (
            <div
              className="chat-outcome-panel"
              onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setExpanded(false) } }}
            >
              <p className="chat-outcome-panel-title">这段对话哪里没解决？<span>（可跳过）</span></p>
              <OutcomeReasonFields draft={draft} disabled={busy} onChange={setDraft} />
              <footer>
                <button type="button" className="chat-outcome-text-btn" disabled={busy} onClick={() => setExpanded(false)}>取消</button>
                <button type="button" className="chat-outcome-text-btn" disabled={busy} onClick={() => { void run(emptyOutcomeDraft('unresolved'), false) }}>跳过</button>
                <button type="button" className="chat-outcome-submit" disabled={busy} onClick={() => { void run(draft, false) }}>
                  记为未解决并开启
                </button>
              </footer>
            </div>
          )}
        </div>
      )}
      {/* 渲染到 body：聊天页是独立层叠上下文，留在原处会被应用顶栏盖住。 */}
      {notice && createPortal(
        <div key={notice.id} className={`chat-context-reset-toast ${notice.tone}`} role="status">
          {notice.text}
        </div>,
        document.body,
      )}
      {explaining && <ContextResetExplainDialog onClose={() => setExplaining(false)} />}
      {pending && (
        <ChatDialog title="记忆保存失败" onClose={() => { if (!resetting) setPending(null) }}>
          <p className="chat-tools-note">
            记忆保存失败（{confirmationReasonText(pending.result)}），当前上下文已保留。
            仍要开启新上下文吗？继续后，这段对话的记忆不会保存，结果评估照常记录。
          </p>
          <footer>
            <button type="button" disabled={resetting} onClick={() => setPending(null)}>取消</button>
            <button type="button" disabled={resetting || generating} onClick={() => { void run(pending.draft, true) }}>
              {resetting ? '正在开启…' : '不保存记忆，继续开启'}
            </button>
          </footer>
        </ChatDialog>
      )}
    </>
  )
}
