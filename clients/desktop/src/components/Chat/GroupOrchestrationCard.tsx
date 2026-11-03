import { useMemo, useState } from 'react'
import { Pencil } from 'lucide-react'
import { agentApi } from '../../api/agent'
import type { ConversationMetadata } from '../../api/agent/types'
import { groupPromptTemplate, mentionBindings } from '../../lib/customGroupForm'
import type { ResolvedGroupDetails } from '../../lib/groupDetails'
import { decodeGroupPrompt, describeGroupEditError, planOrchestrationUpdate, type OrchestrationTarget } from '../../lib/groupMemberChange'
import type { GroupItem } from '../../stores/chat'
import GroupPromptEditor from './GroupPromptEditor'

interface GroupOrchestrationCardProps {
  group: GroupItem
  details: ResolvedGroupDetails
  /** Whether the service has `PUT /conversations/:id/orchestration`; older services take the generic PATCH. */
  dedicatedEndpoint: boolean
  onSaved: (updated: ConversationMetadata) => void
}

/** Orchestration rule of a group. Custom groups get an auto/custom switch and an editor; other groups stay read-only. */
export default function GroupOrchestrationCard({ group, details, dedicatedEndpoint, onSaved }: GroupOrchestrationCardProps) {
  const members = useMemo(() => group.members ?? [], [group.members])
  const bindings = useMemo(() => mentionBindings(members.map(member => ({ employeeId: member.employee_id, displayName: member.display_name }))), [members])
  const memberIds = useMemo(() => members.map(member => member.employee_id), [members])
  const current = group.orchestration?.mode ?? null
  // Rule references can only be encoded against a loaded roster.
  const editable = current !== null && group.rosterStatus === 'loaded'
  const [editing, setEditing] = useState<OrchestrationTarget | null>(null)
  const [ruleDraft, setRuleDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const shown = editing ?? current

  const startEditing = (target: OrchestrationTarget) => {
    const saved = group.orchestration?.mode === 'custom' ? group.orchestration.prompt : null
    setRuleDraft(saved !== null ? decodeGroupPrompt(saved, bindings) : groupPromptTemplate(bindings))
    setDescriptionDraft(group.description ?? '')
    setStatus('')
    setEditing(target)
  }

  const handleSelectMode = (value: OrchestrationTarget) => {
    if (value === shown || saving) return
    if (value === current) {
      setStatus('')
      setEditing(null)
      return
    }
    startEditing(value)
  }

  const handleSave = async () => {
    if (!editing || saving) return
    const plan = planOrchestrationUpdate({ target: editing, ruleText: ruleDraft, description: descriptionDraft, memberIds, bindings })
    if ('error' in plan) {
      setStatus(plan.error)
      return
    }
    setSaving(true)
    setStatus('')
    try {
      const updated = await agentApi.replaceGroupOrchestration(group.id, plan.request, dedicatedEndpoint)
      onSaved(updated)
      setStatus(editing === 'auto' ? '已切换为自动编排，下一轮对话生效。' : '自定义编排已保存，下一轮对话生效。')
      setEditing(null)
    } catch (error) {
      setStatus(describeGroupEditError(error, '编排规则保存失败，请重试。'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="gdp-section" aria-label="编排规则">
      <div className="gdp-section-header">
        <h3 className="gdp-section-title">编排规则</h3>
        {editable ? (
          <div className="gdp-mode-toggle" role="group" aria-label="编排方式">
            {(['auto', 'custom'] as const).map(value => (
              <button key={value} type="button" aria-pressed={shown === value} disabled={saving} onClick={() => handleSelectMode(value)}>
                {value === 'auto' ? '自动' : '自定义'}
              </button>
            ))}
          </div>
        ) : (
          <span className={`gdp-mode-badge is-${details.orchestrationMode}`} title={details.orchestrationModeMessage}>
            {details.orchestrationModeLabel}
          </span>
        )}
      </div>
      {/* 既不是自选成员群也没关联方案时，原因已在群简介区说明，这里只留标签。 */}
      {!editable && details.orchestrationModeLabel !== '未保存编排规则' && <p className="gdp-note">{details.orchestrationModeMessage}</p>}

      {editing === 'custom' && (
        <div className="gdp-editor">
          <p className="gdp-note">
            {current === 'custom'
              ? '规则中的 @ 员工必须是群内成员；保存后下一轮对话生效。'
              : '切换为自定义后，协调人将严格按下方规则协作，不再根据群简介自动规划。输入 @ 选择群内员工。'}
          </p>
          <GroupPromptEditor id={`gdp-rule-${group.id}`} label="自定义编排描述" value={ruleDraft} onChange={setRuleDraft}
            bindings={bindings} disabled={saving} rows={8} autoFocus />
        </div>
      )}
      {editing === 'auto' && (
        <div className="gdp-editor">
          <p className="gdp-note">自动编排以群简介作为协作目标，协调人据此并结合成员能力规划分工。请确认或补充群简介。</p>
          <textarea value={descriptionDraft} maxLength={4000} onChange={event => setDescriptionDraft(event.target.value)}
            aria-label="群简介" disabled={saving} autoFocus />
        </div>
      )}
      {editing && (
        <div className="gdp-editor-actions">
          <button type="button" onClick={() => { setStatus(''); setEditing(null) }} disabled={saving}>取消</button>
          <button type="button" className="primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : editing === current ? '保存规则' : '切换并保存'}
          </button>
        </div>
      )}

      {!editing && (details.coordinatorInstructions ? (
        <div className="gdp-rule">
          <div className="gdp-rule-header">
            <span>{current === 'custom' ? '自定义描述' : '协作说明'}</span>
            {editable && current === 'custom' && (
              <button type="button" className="gdp-action" onClick={() => startEditing('custom')}><Pencil size={12} aria-hidden="true" />编辑</button>
            )}
          </div>
          <p>{details.coordinatorInstructions}</p>
        </div>
      ) : (
        details.orchestrationMessage && <p className="gdp-body-text">{details.orchestrationMessage}</p>
      ))}
      {status && <p className="gdp-status" role="status">{status}</p>}
    </section>
  )
}
