import { useMemo, useState } from 'react'
import { Check, CircleCheck, LoaderCircle, Pencil, RotateCcw } from 'lucide-react'
import { agentApi, AgentApiError } from '../../api/agent'
import type { ContextSegment, ContextSegmentOutcome } from '../../api/agent/types'
import type { useConversationSegments } from '../../hooks/useConversationSegments'
import {
  canEditSegment, dividerOutcome, editWindowText, emptyOutcomeDraft, endedSegmentMessages, isOutcomeDraftChanged, segmentOutcomeDraft,
  segmentSummary, segmentUpdateRequest, type ContextOutcomeDraft,
} from '../../lib/contextOutcome'
import type { ContextResetDividers } from '../../lib/piConverters'
import type { Message } from '../../stores/chat'
import { ChatDialog } from './ChatDialog'
import { OutcomeReasonFields } from './ContextOutcomePrompt'

type ConversationSegments = ReturnType<typeof useConversationSegments>

interface ContextResetDividerProps {
  conversationId: string
  resetId: string
  // 该次重置的记忆保存状态。
  memoryText?: string | null
  segments: ConversationSegments
  // 会话全部消息和分隔线,修改评估时从中取出这一段做摘要。
  messages: readonly Message[]
  dividers: ContextResetDividers
}

const OUTCOME_OPTIONS = [
  { outcome: 'resolved', label: '已解决', hint: '问题得到满足', Icon: CircleCheck },
  { outcome: 'unresolved', label: '未解决', hint: '记录原因，帮员工改进', Icon: RotateCcw },
] as const

/**
 * 历史消息里标记一次上下文重置:分隔线之上的消息不再进入模型上下文。
 * 显示该段的结果评估(按 segment_id == reset_id 合并)和记忆保存状态;7 天内可修改或撤销评估。
 */
export function ContextResetDivider({ conversationId, resetId, memoryText, segments, messages, dividers }: ContextResetDividerProps) {
  const [editing, setEditing] = useState(false)
  // 渲染期间不能读当前时间;挂载时取一次,过期后服务端仍会返回 segment_edit_window_closed。
  const [mountedAt] = useState(Date.now)
  const segment = segments.byResetId.get(resetId)
  const outcome = dividerOutcome(segment)
  const editable = segment !== undefined && canEditSegment(segment, mountedAt, segments.closedIds)
  return (
    <div className="chat-time-divider chat-context-reset-divider">
      {/* separator 的子元素对读屏是展示性的,「修改评估」按钮放在它外面。 */}
      <span role="separator">
        — 新上下文 · <em className={`chat-context-outcome ${outcome.tone}`}>{outcome.text}</em>{memoryText ? ` · ${memoryText}` : ''} —
      </span>
      {editable && (
        <button type="button" className="chat-context-outcome-edit" onClick={() => setEditing(true)}>修改评估</button>
      )}
      {editing && segment && (
        <SegmentOutcomeDialog
          conversationId={conversationId}
          segment={segment}
          segments={segments}
          segmentMessages={endedSegmentMessages(messages, dividers, resetId)}
          memoryText={memoryText}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}

function SegmentOutcomeDialog({ conversationId, segment, segments, segmentMessages, memoryText, onClose }: {
  conversationId: string
  segment: ContextSegment
  segments: ConversationSegments
  segmentMessages: readonly Message[]
  memoryText?: string | null
  onClose: () => void
}) {
  const [draft, setDraft] = useState<ContextOutcomeDraft>(() => segment.outcome ? segmentOutcomeDraft(segment) : emptyOutcomeDraft('resolved'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // 打开时取一次当前时间;摘要只在打开时计算,之后的新消息不属于这一段。
  const [openedAt] = useState(Date.now)
  const [summary] = useState(() => segmentSummary(segment, segmentMessages, memoryText))
  const original = useMemo(() => dividerOutcome(segment), [segment])
  const closed = segments.closedIds.has(segment.segment_id)
  const editWindow = closed ? '已超过 7 天，不能再修改' : editWindowText(segment, openedAt)

  const save = async (next: ContextOutcomeDraft | null) => {
    setSaving(true)
    setError('')
    try {
      // 冲突后父级会重新读取段落,这里总用最新的 revision。
      segments.upsert(await agentApi.updateConversationSegment(conversationId, segment.segment_id, segmentUpdateRequest(next, segment.revision)))
      onClose()
    } catch (err) {
      if (err instanceof AgentApiError && err.code === 'segment_revision_conflict') {
        segments.reload()
        setError('评估已在别处修改，已刷新为最新内容，请确认后重试。')
      } else if (err instanceof AgentApiError && err.code === 'segment_edit_window_closed') {
        segments.markClosed(segment.segment_id)
        setError('已超过 7 天，这段对话的评估不能再修改。')
      } else {
        console.error('[chat] update context segment failed:', err)
        setError('保存评估失败，请稍后重试。')
      }
    } finally {
      setSaving(false)
    }
  }

  const choose = (outcome: ContextSegmentOutcome) => setDraft((current) => ({ ...current, outcome }))
  const disabled = saving || closed
  const changed = isOutcomeDraftChanged(segment, draft)
  return (
    <ChatDialog
      title="修改评估"
      className="chat-outcome-edit-dialog"
      icon={<Pencil size={18} />}
      description={`只改这段对话的结果，新上下文保持开启${editWindow ? ` · ${editWindow}` : ''}`}
      onClose={() => { if (!saving) onClose() }}
    >
      <section className="chat-outcome-summary" aria-label="这段对话">
        <div className="chat-outcome-summary-meta">
          <span>{[summary.range, ...summary.facts].join(' · ')}</span>
          <span>原评估 <em className={`chat-context-outcome ${original.tone}`}>{original.text}</em></span>
        </div>
        {summary.firstQuestion && <p className="chat-outcome-summary-question">“{summary.firstQuestion}”</p>}
      </section>
      <div className="chat-outcome-options" role="radiogroup" aria-label="结果">
        {OUTCOME_OPTIONS.map(({ outcome, label, hint, Icon }) => (
          <button
            key={outcome}
            type="button"
            role="radio"
            aria-checked={draft.outcome === outcome}
            className={`chat-outcome-option ${outcome}`}
            disabled={disabled}
            onClick={() => choose(outcome)}
          >
            <span className="chat-outcome-option-icon" aria-hidden="true"><Icon size={15} strokeWidth={2.2} /></span>
            <span className="chat-outcome-option-text"><strong>{label}</strong><small>{hint}</small></span>
          </button>
        ))}
      </div>
      {draft.outcome === 'unresolved' && (
        <>
          <p className="chat-outcome-fields-title">哪里没解决？<span>（可多选，可不填）</span></p>
          <OutcomeReasonFields draft={draft} disabled={disabled} onChange={setDraft} />
        </>
      )}
      {error && <p className="chat-input-error" role="alert">{error}</p>}
      <footer>
        {segment.outcome && (
          <button type="button" className="chat-outcome-undo" disabled={disabled} title="这段变回未评估，新上下文保持开启" onClick={() => { void save(null) }}>
            撤销评估
          </button>
        )}
        <button type="button" className="chat-outcome-cancel" disabled={saving} onClick={onClose}>取消</button>
        <button
          type="button"
          className="chat-outcome-save"
          disabled={disabled || !changed}
          aria-busy={saving}
          title={changed ? undefined : '评估没有变化'}
          onClick={() => { void save(draft) }}
        >
          {saving
            ? <LoaderCircle className="chat-outcome-save-spinner" size={14} strokeWidth={2.4} aria-hidden="true" />
            : <Check size={14} strokeWidth={2.6} aria-hidden="true" />}
          <span>{saving ? '正在保存…' : '保存修改'}</span>
        </button>
      </footer>
    </ChatDialog>
  )
}
