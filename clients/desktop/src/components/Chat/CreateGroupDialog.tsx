import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Building2, RefreshCw, Search, Users } from 'lucide-react'
import './CreateGroupDialog.css'
import { agentApi } from '../../api/agent'
import { backendApi } from '../../api/backend'
import type { ExpertProjection, OrgTreeNode } from '../../api/agent/types'
import type { CustomGroupCreateRequest } from '../../api/agent/customGroups'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import {
  ALL_DEPARTMENTS, UNASSIGNED_DEPARTMENT, buildOrganizationFilterIndex,
  filterGroupMemberCandidates, resolveDepartmentEmployeeIds,
} from '../../lib/groupMemberFilters'
import { encodeGroupPrompt, groupPromptTemplate, mentionBindings, validateGroupRequest, type EmployeeMention } from '../../lib/customGroupForm'

export type CreateGroupData = CustomGroupCreateRequest
interface CreateGroupDialogProps {
  onClose: () => void
  onCreate: (data: CreateGroupData) => Promise<void>
}
const STEPS = ['基本信息', '选择成员', '编排方式']

export default function CreateGroupDialog({ onClose, onCreate }: CreateGroupDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [coordinatorId, setCoordinatorId] = useState('')
  const [mode, setMode] = useState<'auto' | 'custom'>('auto')
  const [prompt, setPrompt] = useState('')
  const [employees, setEmployees] = useState<ExpertProjection[]>([])
  const [bindings, setBindings] = useState<EmployeeMention[]>([])
  const [loading, setLoading] = useState(false)
  const [dataLoading, setDataLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [supported, setSupported] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [memberQuery, setMemberQuery] = useState('')
  const [departmentId, setDepartmentId] = useState(ALL_DEPARTMENTS)
  const [orgTree, setOrgTree] = useState<OrgTreeNode | null>(null)
  const [orgError, setOrgError] = useState(false)
  const [mentionStart, setMentionStart] = useState<number | null>(null)
  const [mentionQuery, setMentionQuery] = useState('')
  const dialogRef = useDialogFocus<HTMLDivElement>()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sections = useRef<(HTMLElement | null)[]>([])
  const requestSequence = useRef(0)
  const busyRef = useRef(false)
  const createIntent = useRef<{ fingerprint: string; id: string } | null>(null)

  const handleLoad = useCallback(async () => {
    const sequence = ++requestSequence.current
    setDataLoading(true)
    setLoadError(null)
    const results = await Promise.allSettled([agentApi.listExperts(), agentApi.supportsCustomGroups(), backendApi.getOrgTree()])
    if (sequence !== requestSequence.current) return
    const [expertResult, capability, org] = results
    if (expertResult.status === 'fulfilled') {
      const available = expertResult.value.experts.filter(employee => !employee.revoked)
      setEmployees(available)
      setBindings(previous => {
        const known = new Set(previous.map(item => item.id))
        const all = [...previous.map(item => ({ employeeId: item.id, displayName: item.label })),
          ...available.filter(item => !known.has(item.employee_id)).map(item => ({ employeeId: item.employee_id, displayName: item.display_name }))]
        return mentionBindings(all)
      })
    }
    if (expertResult.status === 'rejected' || capability.status === 'rejected') setLoadError('员工或群聊服务读取失败，请重试。')
    setSupported(capability.status === 'fulfilled' && capability.value)
    setOrgTree(org.status === 'fulfilled' ? org.value : null)
    setOrgError(org.status === 'rejected')
    setDataLoading(false)
  }, [])
  useEffect(() => { void handleLoad(); return () => { requestSequence.current += 1 } }, [handleLoad])
  useGlobalShortcutClose({ onClose: () => { if (!busyRef.current) onClose() } })

  const candidates = useMemo(() => employees.map(employee => ({
    employeeId: employee.employee_id, displayName: employee.display_name, roleName: employee.role_title ?? employee.handle,
  })), [employees])
  const availableIds = useMemo(() => new Set(candidates.map(employee => employee.employeeId)), [candidates])
  const organization = useMemo(() => orgTree ? buildOrganizationFilterIndex(orgTree, availableIds) : null, [orgTree, availableIds])
  const visibleMembers = useMemo(() => filterGroupMemberCandidates(candidates, {
    query: memberQuery, departmentEmployeeIds: resolveDepartmentEmployeeIds(organization, departmentId),
  }), [candidates, memberQuery, organization, departmentId])
  useEffect(() => {
    if (departmentId !== ALL_DEPARTMENTS && organization && departmentId !== UNASSIGNED_DEPARTMENT
      && !organization.departments.some(department => department.id === departmentId)) setDepartmentId(ALL_DEPARTMENTS)
  }, [departmentId, organization])
  const selectedBindings = bindings.filter(binding => selectedIds.includes(binding.id))

  const handleToggleMember = (id: string) => {
    setSubmitError(null)
    if (selectedIds.includes(id)) {
      setSelectedIds(selectedIds.filter(value => value !== id))
      if (coordinatorId === id) setCoordinatorId('')
    } else if (selectedIds.length < 32) {
      setSelectedIds([...selectedIds, id])
      if (selectedIds.length === 0) setCoordinatorId(id)
    }
  }

  let encodedPrompt = ''
  let referenceError: string | null = null
  try { encodedPrompt = mode === 'custom' ? encodeGroupPrompt(prompt, bindings, selectedIds) : '' }
  catch (error) { referenceError = (error as Error).message }
  const data: CreateGroupData = {
    id: '', title: name.trim(), description: description.trim() || null,
    member_employee_ids: selectedIds, coordinator_employee_id: coordinatorId,
    orchestration: mode === 'auto' ? { mode: 'auto' } : { mode: 'custom', format: 'collaboration-markdown-v1', prompt: encodedPrompt },
  }
  const validationError = referenceError ?? (selectedIds.some(id => !availableIds.has(id)) ? '已选员工的授权发生变化，请重新选择。' : validateGroupRequest(data))
  const handleInsertMention = (binding: EmployeeMention) => {
    const textarea = textareaRef.current
    const start = mentionStart ?? textarea?.selectionStart ?? prompt.length
    const end = textarea?.selectionEnd ?? prompt.length
    const token = `@【${binding.label}】`
    setPrompt(prompt.slice(0, start) + token + prompt.slice(end))
    setMentionStart(null)
    requestAnimationFrame(() => { textarea?.focus(); textarea?.setSelectionRange(start + token.length, start + token.length) })
  }
  const handleSubmit = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    setSubmitError(null)
    const fingerprint = JSON.stringify(data)
    if (createIntent.current?.fingerprint !== fingerprint) createIntent.current = { fingerprint, id: crypto.randomUUID() }
    try { await onCreate({ ...data, id: createIntent.current.id }) }
    catch (error) {
      const status = (error as { status?: number })?.status
      setSubmitError(status === 403 ? '所选员工的授权或配置已变化，请刷新员工后重试。'
        : status === 404 ? '当前服务暂不支持自定义建群，请更新服务后重试。'
          : error instanceof Error ? error.message : '创建失败，请稍后重试。')
    } finally { busyRef.current = false; setLoading(false) }
  }

  return createPortal(
    <div className="cgd-overlay" onClick={event => { if (event.target === event.currentTarget && !busyRef.current) onClose() }}>
      <div ref={dialogRef} className="cgd" role="dialog" aria-modal="true" aria-labelledby="create-group-title"
        tabIndex={-1} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (mentionStart !== null) setMentionStart(null); else if (!busyRef.current) onClose() }
        }}>
        <div className="cgd-header">
          <div className="cgd-header-title" id="create-group-title">创建群聊</div>
          <div className="cgd-header-sub">选择协作伙伴，设定群用途和协作方式。</div>
        </div>
        <div className="cgd-scroll">
          <div className="cgd-steps">
            {STEPS.map((title, index) => <button type="button" key={title} className="cgd-step clickable active"
              onClick={() => sections.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              <div className="cgd-step-num">{index + 1}</div><div className="cgd-step-title">{title}</div>
            </button>)}
          </div>
          <fieldset className="cgd-body cgd-form" disabled={loading}>
            {(dataLoading || loadError || !supported || orgError) && <div className="cgd-load-state" role="status">
              {dataLoading ? '正在读取可用员工和群聊服务…' : loadError ?? (!supported ? '当前服务尚未支持自定义建群，请更新 Agent 服务。' : '组织信息暂不可用，仍可搜索和选择员工。')}
              {!dataLoading && <button type="button" className="cgd-member-btn" onClick={() => void handleLoad()}><RefreshCw size={12} />重试</button>}
            </div>}
            <section ref={node => { sections.current[0] = node }} className="cgd-section">
              <label className="cgd-field-label" htmlFor="cgd-name">群聊名称</label>
              <input id="cgd-name" className="cgd-input" value={name} maxLength={200} placeholder="填写群聊名称"
                onChange={event => setName(event.target.value)} autoFocus data-dialog-initial-focus />
              <label className="cgd-field-label" htmlFor="cgd-description">群简介{mode === 'auto' ? ' · 必填' : ' · 选填'}</label>
              <textarea id="cgd-description" className="cgd-textarea" rows={3} maxLength={4000} value={description}
                onChange={event => setDescription(event.target.value)} placeholder="请详细描述群的用途" />
              <p className="cgd-hint">{mode === 'auto' ? '协调人会根据群简介和员工能力规划协作。' : '群简介仅用于展示，协作按下方自定义提示词进行。'}</p>
            </section>
            <section ref={node => { sections.current[1] = node }} className="cgd-members">
              <div className="cgd-filter-bar">
                <label className="cgd-search-field"><Search size={14} /><input aria-label="搜索 AI 员工" placeholder="搜索姓名或岗位" value={memberQuery} onChange={event => setMemberQuery(event.target.value)} /></label>
                <label className="cgd-department-field"><Building2 size={14} /><select aria-label="按组织部门筛选" value={departmentId} onChange={event => setDepartmentId(event.target.value)} disabled={!organization}>
                  <option value={ALL_DEPARTMENTS}>全部组织</option>
                  {organization?.departments.map(department => <option key={department.id} value={department.id}>{department.name} ({department.employeeIds.length})</option>)}
                  {Boolean(organization?.unassignedEmployeeIds.length) && <option value={UNASSIGNED_DEPARTMENT}>未归属部门</option>}
                </select></label>
              </div>
              <div className="cgd-members-title">已选 {selectedIds.length}/32 位 AI 员工</div>
              <div className="cgd-selected-chips cgd-selection">
                {selectedBindings.map(binding => <button type="button" key={binding.id} className="cgd-member-btn selected" onClick={() => handleToggleMember(binding.id)} aria-label={`移除 ${binding.label}`}>{binding.label} ×</button>)}
              </div>
              <div className="cgd-members-list">
                {!visibleMembers.length && <p className="cgd-members-empty">{dataLoading ? '正在加载…' : '暂无符合条件的 AI 员工'}</p>}
                {visibleMembers.map(employee => {
                  const selected = selectedIds.includes(employee.employeeId)
                  const expert = employees.find(item => item.employee_id === employee.employeeId)
                  return <div className="cgd-member-row" key={employee.employeeId}>
                    <Users size={22} aria-hidden="true" />
                    <div className="cgd-member-info"><div className="cgd-member-name">{employee.displayName}</div><div className="cgd-member-role">{employee.roleName}</div>
                      <p className="cgd-member-intro">{expert?.persona || '暂无员工简介'}</p></div>
                    <button type="button" className={`cgd-member-btn${selected ? ' selected' : ''}`} aria-pressed={selected} aria-label={`${selected ? '移除' : '选择'} ${employee.displayName}`}
                      disabled={!selected && selectedIds.length >= 32} onClick={() => handleToggleMember(employee.employeeId)}>{selected ? '已选' : '选择'}</button>
                  </div>
                })}
              </div>
              <div className="cgd-coordinator"><label htmlFor="cgd-coordinator">协调人</label>
                <select id="cgd-coordinator" className="cgd-input" value={coordinatorId} onChange={event => setCoordinatorId(event.target.value)}>
                  <option value="">请选择一位已选员工</option>
                  {selectedBindings.map(binding => <option key={binding.id} value={binding.id}>{binding.label}</option>)}
                </select><p className="cgd-hint">负责分配任务、传递成员结果和汇总回复。</p>
              </div>
            </section>
            <section ref={node => { sections.current[2] = node }} className="cgd-schedule">
              <div className="cgd-schedule-label">编排方式</div>
              <div className="cgd-schedule-toggle">
                {(['auto', 'custom'] as const).map(value => <button type="button" key={value} aria-pressed={mode === value}
                  className={`cgd-schedule-btn${mode === value ? ' active' : ''}`} onClick={() => { setMode(value); setMentionStart(null) }}>{value === 'auto' ? '自动' : '自定义'}</button>)}
              </div>
              {mode === 'auto' ? <p className="cgd-hint">收到任务后，协调人根据群简介与所选 AI 员工的职责和能力规划分工。</p> : <>
                <div className="cgd-prompt-header"><label htmlFor="cgd-prompt">协作提示词</label>
                  <button type="button" className="cgd-member-btn" disabled={Boolean(prompt.trim())} onClick={() => setPrompt(groupPromptTemplate(selectedBindings))}>填入模板</button></div>
                <textarea ref={textareaRef} id="cgd-prompt" className="cgd-textarea cgd-prompt" rows={10} value={prompt} maxLength={16000}
                  placeholder="填写协作目标、编号步骤和交付要求；输入 @ 选择群内员工。" onChange={event => {
                    const text = event.target.value
                    setPrompt(text)
                    const caret = event.target.selectionStart
                    const before = text.slice(0, caret)
                    const match = before.match(/@([^@\n【{}]*)$/u)
                    setMentionStart(match ? caret - match[0].length : null)
                    setMentionQuery(match?.[1] ?? '')
                  }} />
                {mentionStart !== null && <div className="cgd-mention-picker" aria-label="插入群成员引用">
                  {selectedBindings.filter(binding => binding.label.includes(mentionQuery)).map(binding => <button type="button" className="cgd-member-btn" key={binding.id} onMouseDown={event => event.preventDefault()} onClick={() => handleInsertMention(binding)}>{binding.label}</button>)}
                  {!selectedBindings.length && <span>请先选择 AI 员工。</span>}
                </div>}
                <p className="cgd-hint">按“协作目标、编号步骤、最终交付”描述。用 @ 指定员工，向现实用户取信息时写“向用户提问”。</p>
                {referenceError && <p className="cgd-submit-error" role="alert">{referenceError}</p>}
              </>}
            </section>
          </fieldset>
        </div>
        <div className="cgd-footer">
          <p className={submitError ? 'cgd-submit-error' : 'cgd-hint'} role={submitError ? 'alert' : undefined}>{submitError ?? validationError}</p>
          <button type="button" className="cgd-footer-btn" onClick={onClose} disabled={loading}>取消</button>
          <button type="button" className="cgd-footer-btn primary" onClick={() => void handleSubmit()} disabled={loading} aria-busy={loading}>{loading ? '创建中…' : '创建群聊'}</button>
        </div>
      </div>
    </div>, document.body,
  )
}
