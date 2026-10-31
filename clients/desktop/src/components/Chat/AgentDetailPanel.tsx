/**
 * AgentDetailPanel —— 点击对话右上角"更多"按钮后弹出的员工详情侧边栏。
 * 数据来源：useChatStore().conversationDetail.employee_summary（由 toggleDetail 触发请求写入）
 * 关闭方式：再次点击"更多"按钮，或切换对话时自动收起。
 */
import { useCallback, useEffect, useState, type AnimationEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, Zap, UserRound, Camera, Maximize2, LoaderCircle } from 'lucide-react'
import './AgentDetailPanel.css'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import { EMPLOYEE_SERVICE_CONTROL_AVAILABILITY } from '../../lib/serviceWriteAvailability'
import { useChatStore } from '../../stores/chat'
import RequestErrorState from '../RequestState/RequestErrorState'
import { backendApi } from '../../api/backend'
import { agentApi } from '../../api/agent'
import type { AutomationTask } from '../../api/agent/automationTasks'
import { getAvatarFallback, getEmployeeAvatar, renderAvatar } from '../../lib/avatarUtils'
import EmployeeUsageCard from '../Usage/EmployeeUsageCard'
import EmployeeMemoryView from './EmployeeMemoryView'
import { useEmployeeMemorySummary } from '../../hooks/useEmployeeMemorySummary'
import { memoryEntryLabel } from '../../lib/employeeMemory'

export default function AgentDetailPanel() {
  const {
    detailOpen,
    conversationDetail,
    conversationDetailLoading,
    conversationDetailError,
    loadConversationDetail,
    workbenchEmployees,
    activeConvId,
    conversations,
  } = useChatStore()
  // visible 控制 DOM 是否挂载；closing 触发退出动画，动画结束后再卸载
  const [visible, setVisible] = useState(detailOpen)
  const [closing, setClosing] = useState(false)
  const [avatarViewer, setAvatarViewer] = useState(false)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [avatarError, setAvatarError] = useState('')
  const [automationOpen, setAutomationOpen] = useState(false)
  const [employeeAutomationTasks, setEmployeeAutomationTasks] = useState<AutomationTask[]>([])
  const [automationLoading, setAutomationLoading] = useState(false)
  const [automationError, setAutomationError] = useState('')
  const [editingAutomationTask, setEditingAutomationTask] = useState<AutomationTask | null>(null)
  const [automationTaskName, setAutomationTaskName] = useState('')
  const [automationTaskPrompt, setAutomationTaskPrompt] = useState('')
  const [automationTaskBusy, setAutomationTaskBusy] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const navigate = useNavigate()
  const handleClose = useCallback(() => {
    useChatStore.setState({ detailOpen: false })
  }, [])

  useGlobalShortcutClose({ active: detailOpen, layer: 'panel', onClose: handleClose })

  // 新栈从 ConversationMetadata.entry_employee_id + workbenchEmployees 反查员工信息。
  // conversationDetail 目前只提供 entry_employee_id,员工的 display_name/handle/avatar/skills/persona
  // 来自 ExpertProjection,由 store 透传到 workbenchEmployees。
  const employeeId = conversationDetail?.entry_employee_id
    ?? conversations.find((c) => c.id === activeConvId)?._employeeId
  const employee = employeeId ? workbenchEmployees.find((e) => e.employeeId === employeeId) : undefined
  const emp = employee
    ? {
        display_name: employee.displayName,
        avatar_url: employee.avatarUrl ?? undefined,
        skills: employee.skills ?? [],
        persona: employee.persona,
        memorySummary: employee.memorySummary,
        modelName: employee.modelName,
        modelProvider: employee.modelProvider,
        connectorRefs: employee.connectorRefs ?? [],
        knowledgeRefs: employee.knowledgeRefs ?? [],
        automationTasks: employee.automationTasks ?? [],
        // usage 只接受 WorkbenchEmployee 的显式领域字段；当前 ExpertProjection 未承诺时保持缺失。
        usage: employee.usage,
      }
    : undefined
  // 面板打开时才读取记忆条数；旧版 Agent 没有记忆接口时隐藏「查看全部」。
  const { state: memorySummaryState, reload: reloadMemorySummary } = useEmployeeMemorySummary(detailOpen && employeeId ? employeeId : null)

  useEffect(() => {
    if (detailOpen) {
      // 打开：先挂载 DOM，再播放进入动画
      setVisible(true)
      setClosing(false)
    } else if (visible) {
      // 关闭：先播放退出动画，动画结束后由 handleAnimationEnd 卸载 DOM
      setClosing(true)
    }
  }, [detailOpen, visible])

  useEffect(() => {
    setAutomationOpen(false)
    setEmployeeAutomationTasks([])
    setEditingAutomationTask(null)
    setAutomationError('')
    setMemoryOpen(false)
  }, [employeeId])

  // 面板未打开且不在关闭动画中，直接不渲染节省资源
  if (!visible) return null

  const handleAnimationEnd = (event: AnimationEvent<HTMLElement>) => {
    // 只响应 aside 自身的动画结束事件，忽略子元素冒泡上来的
    if (event.currentTarget !== event.target) return
    if (closing) setVisible(false)
  }

  // 数据兜底：接口返回前显示占位符，避免空白
  const initial = emp?.display_name?.slice(0, 1) ?? '?'
  const name = emp?.display_name ?? '—'
  const persona = emp?.persona ?? ''
  const skills = emp?.skills ?? []
  const memorySummary = emp?.memorySummary ?? ''
  const modelName = emp?.modelName ?? emp?.modelProvider ?? ''
  const connectorRefs = emp?.connectorRefs ?? []
  const knowledgeRefs = emp?.knowledgeRefs ?? []
  const configuredAutomationTasks = emp?.automationTasks ?? []
  const avatarUrl = emp?.avatar_url
  const resolvedAvatarUrl = avatarUrl ? getEmployeeAvatar(name, avatarUrl) : null
  const openAutomationTasks = async () => {
    if (!employeeId || automationLoading) return
    setAutomationOpen(true)
    setEditingAutomationTask(null)
    setAutomationLoading(true)
    setAutomationError('')
    try {
      const result = await agentApi.listAutomationTasks({ employee_id: employeeId, status: 'all', limit: 100 })
      setEmployeeAutomationTasks(result.data)
    } catch (error) {
      setAutomationError(error instanceof Error ? error.message : '自动化任务加载失败，请重试。')
    } finally {
      setAutomationLoading(false)
    }
  }

  const toggleAutomationTask = async (task: AutomationTask) => {
    if (automationTaskBusy || task.status === 'completed') return
    setAutomationTaskBusy(true)
    setAutomationError('')
    try {
      const updated = await agentApi.setAutomationTaskAction(task.task_id, task.status === 'active' ? 'pause' : 'enable', task.etag)
      setEmployeeAutomationTasks(items => items.map(item => item.task_id === updated.task_id ? updated : item))
    } catch (error) {
      setAutomationError(error instanceof Error ? error.message : '任务状态更新失败，请重试。')
    } finally {
      setAutomationTaskBusy(false)
    }
  }

  const beginAutomationTaskEdit = (task: AutomationTask) => {
    setEditingAutomationTask(task)
    setAutomationTaskName(task.name)
    setAutomationTaskPrompt(task.prompt ?? task.prompt_summary)
    setAutomationError('')
  }

  const saveAutomationTaskEdit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editingAutomationTask || !automationTaskName.trim() || !automationTaskPrompt.trim() || automationTaskBusy) return
    setAutomationTaskBusy(true)
    setAutomationError('')
    try {
      const updated = await agentApi.updateAutomationTask(editingAutomationTask.task_id, {
        name: automationTaskName.trim(),
        prompt: automationTaskPrompt.trim(),
      }, editingAutomationTask.etag)
      setEmployeeAutomationTasks(items => items.map(item => item.task_id === updated.task_id ? updated : item))
      setEditingAutomationTask(null)
    } catch (error) {
      setAutomationError(error instanceof Error ? error.message : '任务保存失败，请重试。')
    } finally {
      setAutomationTaskBusy(false)
    }
  }

  const handleAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'] as const
    const mimeType = file ? allowedTypes.find(type => type === file.type) : undefined
    if (!file || !employeeId || !mimeType) {
      if (file) setAvatarError('仅支持 JPEG、PNG 或 WebP 图片')
      return
    }
    if (file.size > 5 * 1024 * 1024) { setAvatarError('头像不能超过 5MB'); return }
    setAvatarUploading(true); setAvatarError('')
    try {
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(new Error('头像读取失败')); reader.readAsDataURL(file) })
      const result = await backendApi.updateEmployeeAvatar(employeeId, { data, mime_type: mimeType, filename: file.name })
      // The content endpoint is cacheable for a few minutes. Include the
      // returned local version so replacing an existing avatar is visible
      // immediately instead of reusing the previous binary response.
      const avatarUrl = result.avatar_url
        ? `${result.avatar_url}${result.avatar_url.includes('?') ? '&' : '?'}v=${result.version}`
        : null
      useChatStore.setState(state => ({
        workbenchEmployees: state.workbenchEmployees.map(item => item.employeeId === employeeId ? { ...item, avatarUrl } : item),
        conversations: state.conversations.map(item => item._employeeId === employeeId ? { ...item, agentAvatarUrl: avatarUrl } : item),
      }))
    } catch (error) { setAvatarError(error instanceof Error ? error.message : '头像更新失败') } finally { setAvatarUploading(false); event.target.value = '' }
  }

  // 头像显示逻辑：优先使用自定义头像URL，否则显示首字符
  const avatarDisplay = resolvedAvatarUrl
    ? renderAvatar(resolvedAvatarUrl, getAvatarFallback(name))
    : initial

  return (
    <aside className={`adp${closing ? ' closing' : ''}`} onAnimationEnd={handleAnimationEnd}>
      <div className="adp-inner">
        <div className="adp-header">
          <div className="adp-header-text">
            <span className="adp-title">员工详情</span>
          </div>
          <button
            className="adp-close"
            onClick={handleClose}
            aria-label="关闭"
            aria-keyshortcuts="Meta+W Control+W"
            title="关闭员工详情（⌘W / Ctrl+W）"
          >
            <X size={13} strokeWidth={1.8} />
          </button>
        </div>

        <div className="adp-body">
          {conversationDetailLoading && (
            <div className="adp-load-state" role="status">正在加载员工详情…</div>
          )}
          {conversationDetailError && (
            <RequestErrorState
              compact
              className="adp-request-error"
              error={conversationDetailError}
              onRetry={() => void loadConversationDetail()}
              retrying={conversationDetailLoading}
            />
          )}

          {/* Card 1: identity */}
          <div className="adp-card adp-identity-card">
            <button type="button" className="adp-avatar adp-avatar-button" onClick={() => setAvatarViewer(true)} aria-label="查看头像大图" title="查看大图">
              {avatarDisplay}
              <span className="adp-avatar-hover"><Maximize2 size={14} /></span>
            </button>
            <div className="adp-identity-info">
              <span className="adp-user-name">{name}</span>
            </div>
          </div>
          {avatarError && <p className="adp-avatar-error" role="alert">{avatarError}</p>}

          {employeeId && <EmployeeUsageCard employeeId={employeeId} />}

          {/* 员工档案信息 */}
          <div className="adp-card">
            <div className="adp-card-header">
              <UserRound size={13} strokeWidth={1.8} className="adp-card-icon" />
              <span className="adp-card-title">岗位描述</span>
            </div>
            {persona ? (
              <p className="adp-persona-text">{persona}</p>
            ) : (
              <span className="adp-empty-text">暂无简介</span>
            )}
          </div>

          {/* Card 3: skills */}
          <div className="adp-card">
            <div className="adp-card-header">
              <Zap size={13} strokeWidth={1.8} className="adp-card-icon" />
              <span className="adp-card-title">擅长技能 · 能做什么</span>
            </div>
            {skills.length > 0 ? (
              <div className="adp-tags">
                <span className="adp-capability-text">可以帮助你完成{skills.slice(0, 4).join('、')}等工作，并把复杂任务整理成可执行结果。</span>
              </div>
            ) : (
              <span className="adp-empty-text">暂无技能信息</span>
            )}
          </div>

          <div className="adp-card adp-feature-card"><div className="adp-card-header"><span className="adp-card-title">记忆摘要</span>{employeeId && memorySummaryState.status !== 'unsupported' && <button type="button" className="adp-inline-action" onClick={() => setMemoryOpen(true)}>{memoryEntryLabel(memorySummaryState.status === 'ready' ? memorySummaryState.data : null)}</button>}</div><p className="adp-persona-text">{memorySummary || '最近 3 天暂无新的记忆摘要'}</p><span className="adp-period">最近 3 天</span></div>
          <div className="adp-card adp-meta-grid"><div><span>模型</span><strong>{modelName || '暂无模型配置'}</strong></div><div><span>可操作系统</span><strong>{connectorRefs.length ? connectorRefs.join('、') : '暂无已配置的 MCP 系统'}</strong></div></div>
          <div className="adp-card"><div className="adp-card-header"><span className="adp-card-title">关联资源</span></div><button className="adp-resource-row" onClick={() => navigate(`/knowledge?employee=${employeeId}`)}><span>关联的知识库</span><b>{knowledgeRefs.length ? knowledgeRefs.join('、') : '查看详情 →'}</b></button><button className="adp-resource-row" onClick={() => void openAutomationTasks()}><span>自动化任务</span><b>{configuredAutomationTasks.length ? configuredAutomationTasks.join('、') : '查看列表 →'}</b></button></div>

        </div>

        {memoryOpen && employeeId && (
          <EmployeeMemoryView
            employeeId={employeeId}
            employeeName={name}
            summary={memorySummaryState}
            onSummaryChange={reloadMemorySummary}
            onClose={() => setMemoryOpen(false)}
          />
        )}
        {automationOpen && (
          <div className="adp-nested-view" role="dialog" aria-label="员工自动化任务列表">
            <div className="adp-nested-header">
              <button type="button" className="adp-nested-back" aria-label="返回员工详情" title="返回员工详情" onClick={() => { setAutomationOpen(false); setEditingAutomationTask(null) }}>‹</button>
              <strong>{editingAutomationTask ? '编辑自动化任务' : '自动化任务'}</strong>
              <span>{editingAutomationTask ? '' : `${employeeAutomationTasks.length} 项`}</span>
            </div>
            <div className="adp-nested-body" aria-busy={automationLoading || automationTaskBusy}>
              {editingAutomationTask ? (
                <form className="adp-task-editor" onSubmit={(event) => void saveAutomationTaskEdit(event)}>
                  <label>任务名称<input value={automationTaskName} maxLength={120} onChange={event => setAutomationTaskName(event.target.value)} /></label>
                  <label>执行指令<textarea value={automationTaskPrompt} maxLength={20_000} rows={8} onChange={event => setAutomationTaskPrompt(event.target.value)} /></label>
                  <div className="adp-task-editor-actions"><button type="button" onClick={() => setEditingAutomationTask(null)} disabled={automationTaskBusy}>取消</button><button type="submit" className="primary" disabled={automationTaskBusy || !automationTaskName.trim() || !automationTaskPrompt.trim()}>{automationTaskBusy ? '保存中…' : '保存'}</button></div>
                </form>
              ) : (
                <>
                  {automationLoading && <div className="adp-nested-state"><LoaderCircle className="adp-nested-spinner" size={18} />正在加载任务…</div>}
                  {!automationLoading && automationError && <div className="adp-nested-state adp-nested-error"><span>{automationError}</span><button type="button" onClick={() => void openAutomationTasks()}>重试</button></div>}
                  {!automationLoading && !automationError && employeeAutomationTasks.length === 0 && <div className="adp-nested-state">该员工暂无自动化任务。</div>}
                  {!automationLoading && !automationError && employeeAutomationTasks.map(task => (
                    <article className="adp-task-item" key={task.task_id}>
                      <div className="adp-task-item-top"><strong>{task.name}</strong><span className={`adp-task-status ${task.status}`}>{task.status === 'active' ? '启用中' : task.status === 'paused' ? '已暂停' : '已完成'}</span></div>
                      <p>{task.prompt_summary || task.prompt || '暂无任务描述'}</p>
                      {task.next_run_at && <small>下次执行：{new Date(task.next_run_at).toLocaleString('zh-CN')}</small>}
                      <div className="adp-task-item-actions"><button type="button" onClick={() => void toggleAutomationTask(task)} disabled={automationTaskBusy || task.status === 'completed'}>{task.status === 'active' ? '关闭任务' : task.status === 'paused' ? '开启任务' : '不可操作'}</button><button type="button" onClick={() => beginAutomationTaskEdit(task)} disabled={automationTaskBusy}>编辑</button></div>
                    </article>
                  ))}
                </>
              )}
            </div>
          </div>
        )}
        <div className="adp-footer">
          <p id="employee-service-control-reason" className="adp-action-note" role="note">
            {EMPLOYEE_SERVICE_CONTROL_AVAILABILITY.reason}
          </p>
          <div className="adp-footer-actions">
            <button className="adp-btn-secondary" onClick={() => navigate('/talents')}>
              查看完整资料
            </button>
            <button
              className="adp-btn-primary"
              type="button"
              disabled={!EMPLOYEE_SERVICE_CONTROL_AVAILABILITY.enabled}
              aria-describedby="employee-service-control-reason"
              title={EMPLOYEE_SERVICE_CONTROL_AVAILABILITY.reason}
            >
              暂停 / 恢复服务
            </button>
          </div>
        </div>
      </div>
      {avatarViewer && (
        <div className="adp-avatar-modal" role="dialog" aria-modal="true" aria-label={`${name}头像预览`} onClick={() => setAvatarViewer(false)}>
          <div className="adp-avatar-preview" onClick={event => event.stopPropagation()}>
            <div className="adp-avatar-preview-header">
              <span>头像预览</span>
              <button type="button" className="adp-close" onClick={() => setAvatarViewer(false)} aria-label="关闭预览"><X size={16} /></button>
            </div>
            <div className="adp-avatar-large">{resolvedAvatarUrl ? renderAvatar(resolvedAvatarUrl, getAvatarFallback(name)) : initial}</div>
            <label className="adp-avatar-upload">
              {avatarUploading ? '正在上传…' : <><Camera size={15} />切换头像</>}
              <input hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={handleAvatarUpload} disabled={avatarUploading} />
            </label>
          </div>
        </div>
      )}
    </aside>
  )
}
