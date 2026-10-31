import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RefreshCw, Search } from 'lucide-react'
import './CreateGroupDialog.css'
import { agentApi } from '../../api/agent'
import type { GroupMembersUpdateResult, GroupOrchestration } from '../../api/agent/customGroups'
import type { ExpertProjection } from '../../api/agent/types'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import { mentionBindings } from '../../lib/customGroupForm'
import {
  MAX_GROUP_MEMBERS, decodeGroupPrompt, describeGroupEditError, nextRoster,
  planMemberUpdate, promptReferences, removedReferences,
} from '../../lib/groupMemberChange'
import type { GroupMember } from '../../stores/chat'
import GroupPromptEditor from './GroupPromptEditor'

interface GroupMembersDialogProps {
  groupId: string
  members: readonly GroupMember[]
  orchestration: GroupOrchestration
  onClose: () => void
  onSaved: (result: GroupMembersUpdateResult, experts: ExpertProjection[]) => void
}

/** Add/remove members of a custom group, and keep its collaboration rule consistent with the new roster. */
export default function GroupMembersDialog({ groupId, members, orchestration, onClose, onSaved }: GroupMembersDialogProps) {
  const [experts, setExperts] = useState<ExpertProjection[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [add, setAdd] = useState<string[]>([])
  const [remove, setRemove] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [ruleEdit, setRuleEdit] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const alive = useRef(true)
  const dialogRef = useDialogFocus<HTMLDivElement>()

  useGlobalShortcutClose({ onClose: () => { if (!busyRef.current) onClose() } })
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const loadExperts = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const { experts: list } = await agentApi.listExperts()
      if (alive.current) setExperts(list.filter(item => !item.revoked))
    } catch {
      if (alive.current) setLoadError(true)
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])
  useEffect(() => { void loadExperts() }, [loadExperts])

  const currentIds = useMemo(() => members.map(member => member.employee_id), [members])
  const coordinatorId = members.find(member => member.is_system_planner)?.employee_id ?? null
  const candidates = useMemo(() => experts.filter(expert => !currentIds.includes(expert.employee_id)), [experts, currentIds])
  const bindings = useMemo(() => mentionBindings([
    ...members.map(member => ({ employeeId: member.employee_id, displayName: member.display_name })),
    ...candidates.map(expert => ({ employeeId: expert.employee_id, displayName: expert.display_name })),
  ]), [members, candidates])

  const change = { currentIds, coordinatorId, add, remove }
  const finalIds = nextRoster(change)
  const isCustom = orchestration.mode === 'custom'
  const ruleText = ruleEdit ?? (orchestration.mode === 'custom' ? decodeGroupPrompt(orchestration.prompt, bindings) : '')
  const dangling = isCustom ? removedReferences(ruleText, bindings, remove) : []
  const mentioned = isCustom ? promptReferences(ruleText, bindings) : []
  const notInRule = add.filter(id => !mentioned.includes(id)).map(id => bindings.find(item => item.id === id)?.label ?? id)
  const plan = planMemberUpdate({ change, orchestration, ruleText, bindings })
  const blocker = dangling.length
    ? `协作规则仍引用将移出的成员：${dangling.join('、')}，请先改写规则。`
    : 'error' in plan ? plan.error : null
  const summary = `加入 ${add.length} 位 · 移出 ${remove.length} 位 · 变更后共 ${finalIds.length}/${MAX_GROUP_MEMBERS} 位`

  const needle = query.trim().toLocaleLowerCase()
  const visible = candidates.filter(expert =>
    !needle || `${expert.display_name} ${expert.role_title ?? ''} ${expert.handle}`.toLocaleLowerCase().includes(needle))
  const rulePickerBindings = bindings.filter(binding => finalIds.includes(binding.id))

  const toggle = (setter: (update: (list: string[]) => string[]) => void) => (id: string) => {
    setError(null)
    setter(list => list.includes(id) ? list.filter(item => item !== id) : [...list, id])
  }
  const toggleAdd = toggle(setAdd)
  const toggleRemove = toggle(setRemove)

  const handleSave = async () => {
    if (busyRef.current || blocker || !('request' in plan)) return
    busyRef.current = true
    setSaving(true)
    setError(null)
    try {
      const result = await agentApi.updateGroupMembers(groupId, plan.request)
      onSaved(result, experts)
    } catch (caught) {
      setError(describeGroupEditError(caught, '成员变更失败，请稍后重试。'))
    } finally {
      busyRef.current = false
      setSaving(false)
    }
  }

  return createPortal(
    <div className="cgd-overlay" onClick={event => { if (event.target === event.currentTarget && !busyRef.current) onClose() }}>
      <div ref={dialogRef} className="cgd" role="dialog" aria-modal="true" aria-labelledby="group-members-title" tabIndex={-1}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busyRef.current) onClose() } }}>
        <div className="cgd-header">
          <div className="cgd-header-title" id="group-members-title">管理群成员</div>
          <div className="cgd-header-sub">加入或移出成员。成员变动会影响群的编排规则，请一并确认。</div>
        </div>
        <div className="cgd-scroll">
          <fieldset className="cgd-body cgd-form" disabled={saving}>
            <section className="cgd-members">
              <div className="cgd-members-title">当前成员 {currentIds.length} 位</div>
              <div className="cgd-members-list">
                {members.map(member => {
                  const isCoordinator = member.employee_id === coordinatorId
                  const marked = remove.includes(member.employee_id)
                  return <div className="cgd-member-row" key={member.employee_id}>
                    <div className="cgd-member-info">
                      <div className="cgd-member-name">{member.display_name}{isCoordinator ? ' · 协调人' : ''}</div>
                      <div className="cgd-member-role">{member.role_name ?? '岗位未设置'}</div>
                    </div>
                    <button type="button" className={`cgd-member-btn${marked ? ' selected' : ''}`} aria-pressed={marked}
                      aria-label={`${marked ? '撤销移出' : '移出'} ${member.display_name}`} disabled={isCoordinator}
                      title={isCoordinator ? '协调人不能移出群聊' : undefined}
                      onClick={() => toggleRemove(member.employee_id)}>{marked ? '将移出' : '移出'}</button>
                  </div>
                })}
              </div>
            </section>

            <section className="cgd-members">
              <div className="cgd-filter-bar">
                <label className="cgd-search-field"><Search size={14} aria-hidden="true" />
                  <input aria-label="搜索可加入的 AI 员工" placeholder="搜索姓名或岗位" value={query} onChange={event => setQuery(event.target.value)} />
                </label>
              </div>
              <div className="cgd-members-title">可加入的 AI 员工</div>
              <div className="cgd-members-list">
                {loading && <p className="cgd-members-empty">正在读取可用员工…</p>}
                {!loading && loadError && <p className="cgd-members-empty" role="alert">员工读取失败。
                  <button type="button" className="cgd-member-btn" onClick={() => void loadExperts()}><RefreshCw size={12} aria-hidden="true" />重试</button></p>}
                {!loading && !loadError && !visible.length && <p className="cgd-members-empty">{candidates.length ? '没有符合条件的 AI 员工' : '所有已授权员工都在群内'}</p>}
                {visible.map(expert => {
                  const picked = add.includes(expert.employee_id)
                  return <div className="cgd-member-row" key={expert.employee_id}>
                    <div className="cgd-member-info">
                      <div className="cgd-member-name">{expert.display_name}</div>
                      <div className="cgd-member-role">{expert.role_title ?? expert.handle}</div>
                      <p className="cgd-member-intro">{expert.persona || '暂无员工简介'}</p>
                    </div>
                    <button type="button" className={`cgd-member-btn${picked ? ' selected' : ''}`} aria-pressed={picked}
                      aria-label={`${picked ? '取消加入' : '加入'} ${expert.display_name}`}
                      disabled={!picked && finalIds.length >= MAX_GROUP_MEMBERS}
                      onClick={() => toggleAdd(expert.employee_id)}>{picked ? '将加入' : '加入'}</button>
                  </div>
                })}
              </div>
            </section>

            <section className="cgd-schedule">
              <div className="cgd-schedule-label">编排规则 · {isCustom ? '自定义' : '自动'}</div>
              {isCustom ? <>
                <p className="cgd-hint">规则中 @ 的成员必须仍在群内：被移出的成员如果被引用，请先改写；新加入的成员不会自动参与协作，需要时请在规则里 @ 他们。</p>
                {dangling.length > 0 && <p className="cgd-submit-error" role="alert">规则仍引用将移出的成员：{dangling.join('、')}。</p>}
                {notInRule.length > 0 && <p className="cgd-hint" role="status">规则尚未提到新成员：{notInRule.join('、')}。</p>}
                <label className="cgd-field-label" htmlFor="gmd-rule">协作规则</label>
                <GroupPromptEditor id="gmd-rule" label="自定义编排规则" value={ruleText} onChange={setRuleEdit}
                  bindings={rulePickerBindings} disabled={saving} rows={8} />
              </> : (
                <p className="cgd-hint">当前为自动编排：协调人会根据群简介和成员的职责能力规划分工，成员变动后无需改写规则。如需固定协作流程，可在详情页切换为自定义编排。</p>
              )}
            </section>
          </fieldset>
        </div>
        <div className="cgd-footer">
          <p className={error || (blocker && (add.length + remove.length) > 0) ? 'cgd-submit-error' : 'cgd-hint'} role={error ? 'alert' : undefined}>{error ?? blocker ?? summary}</p>
          <button type="button" className="cgd-footer-btn" onClick={onClose} disabled={saving}>取消</button>
          <button type="button" className="cgd-footer-btn primary" onClick={() => void handleSave()} disabled={saving || Boolean(blocker)} aria-busy={saving}>{saving ? '保存中…' : '保存变更'}</button>
        </div>
      </div>
    </div>, document.body,
  )
}
