import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Building2, BotMessageSquare, CircleAlert, CircleCheck, LoaderCircle, Minus, Plus, Maximize2, X } from 'lucide-react'
import { DndContext } from '@dnd-kit/core'
import './OrgChart.css'
import { DeptDragGhost, DeptDragNode } from './DeptDragNode'
import { ROOT_DROP_ID, landingOf, type DropIntent } from './dropIntent'
import { useDeptDrag } from './useDeptDrag'
import { DeleteDeptDialog } from './DeleteDeptDialog'
import { AssignDepartmentDialog } from './AssignDepartmentDialog'
import CreateDeptDialog from './CreateDeptDialog'
import { RenameDeptDialog } from './RenameDeptDialog'
import { MemberActionPopup } from './MemberActionPopup'
import { deleteDepartmentRemote, describeOrgError, fetchOrgTree, moveDepartmentRemote, promoteDepartmentRemote, renameDepartmentRemote, type ApiDepartment, type ApiEmployee, type ApiStats, type ApiEnterprise } from './api'
import { getOrgChartWriteAvailability, isWriteActionDisabled } from '../../lib/serviceWriteAvailability'
import { useAgentAuthStore } from '../../stores/agentAuth'
import { openEmployeeChat } from '../../lib/openEmployeeChat'
import RequestErrorState from '../../components/RequestState/RequestErrorState'
import { agentApi } from '../../api/agent'
import { loadEmployeeReadiness, resolveEmployeeChatStatus, type EmployeeChatFacts } from '../../lib/employeeChatStatus'
import { loadEmployeeMarketFacts } from '../TalentMarket/talentEmployeeChat'
import { classifyRequestError, type RequestErrorInfo } from '../../lib/requestError'
import {
  DEFAULT_DEPARTMENT_ID,
  collectEmployeesFromTree,
  SERVER_UNASSIGNED_DEPARTMENT_ID,
  findDepartment,
  groupEmployeesByDepartment,
  isAncestor,
} from './orgTree'
import { calculateFitScale } from '../../lib/fitScale'

const DEPT_COLORS = ['#e89a2e', '#60a5fa', '#a78bfa', '#f472b6', '#4ade80']

function collectTopLevelCols(departments: ApiDepartment[]): ApiDepartment[] {
  // API 适配层返回的就是根节点直属部门；它们的 parent_id 会指向企业根节点，不能再按空值过滤。
  return departments
}

// 递归收集部门下所有员工(含子部门),用于顶层列的头部计数与角色标签汇总。
function collectDeptEmployees(dept: ApiDepartment): ApiEmployee[] {
  const list: ApiEmployee[] = [...(dept.members ?? [])]
  ;(dept.children ?? []).forEach((c) => list.push(...collectDeptEmployees(c)))
  return list
}

// ─── StatCard 组件 ───
interface StatCardProps {
  label: string
  value: number | string
  desc: string
}
function StatCard({ label, value, desc }: StatCardProps) {
  return (
    <div className="oc-stat-card">
      <div className="oc-stat-label">{label}</div>
      <div className="oc-stat-value">{value}</div>
      <div className="oc-stat-desc">{desc}</div>
    </div>
  )
}

type OrgNotice = { tone: 'ok' | 'error' | 'saving'; text: string }

const NOTICE_ICONS = { ok: CircleCheck, error: CircleAlert, saving: LoaderCircle } as const

// 操作结果浮在画布底部，不占用页面布局：出现或消失时组织图不会上下跳动。
function OrgToast({ notice, onClose }: { notice: OrgNotice; onClose: () => void }) {
  const Icon = NOTICE_ICONS[notice.tone]
  return (
    <div className={`oc-toast oc-toast--${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <Icon className="oc-toast-icon" size={15} strokeWidth={2} aria-hidden="true" />
      <span className="oc-toast-text">{notice.text}</span>
      {notice.tone !== 'saving' && (
        <button type="button" className="oc-toast-close" aria-label="关闭提示" onClick={onClose}>
          <X size={13} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}

export default function OrgChart() {
  const navigate = useNavigate()
  const writeAvailability = getOrgChartWriteAvailability(useAgentAuthStore(state => state.claims?.roles))
  const [assigningEmployee, setAssigningEmployee] = useState<ApiEmployee | null>(null)
  const [creatingDept, setCreatingDept] = useState(false)
  const [renamingDept, setRenamingDept] = useState<{ id: string; name: string } | null>(null)
  const [enterprise, setEnterprise] = useState<ApiEnterprise | null>(null)
  const [departments, setDepartments] = useState<ApiDepartment[]>([])
  const [stats, setStats] = useState<ApiStats | null>(null)
  const [rawEmps, setRawEmps] = useState<ApiEmployee[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<RequestErrorInfo | null>(null)
  const [zoom, setZoom] = useState(1)
  const [deletingDept, setDeletingDept] = useState<{ id: string; name: string } | null>(null)
  // 正在保存的部门 id：保存期间暂停拖动，该部门卡片显示“保存中”。
  const [savingId, setSavingId] = useState<string | null>(null)
  // 刚移动到新位置的部门 id：短暂高亮，让人看清它落在了哪里。
  const [justMovedId, setJustMovedId] = useState<string | null>(null)
  const [moveMessage, setMoveMessage] = useState<OrgNotice | null>(null)
  // 移动后要滚到可见处、（键盘操作时）还要聚焦的部门，等新部门树渲染出来后处理。
  const revealRef = useRef<{ id: string; focus: boolean } | null>(null)
  const canvasWrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  // 成员操作弹窗
  const [popup, setPopup] = useState<{ emp: ApiEmployee; x: number; y: number } | null>(null)

  const loadData = useCallback((silent = false) => {
    let cancelled = false
    // silent：保存后静默同步服务端数据，不闪“加载中”。
    if (!silent) setLoading(true)
    setError(null)
    void fetchOrgTree()
      .then((res) => {
        if (cancelled) return
        setEnterprise(res.enterprise)
        setDepartments(res.departments)
        setStats(res.stats)
        const fromTree = collectEmployeesFromTree(res.departments)
        const unassigned = res.unassigned_members ?? []
        setRawEmps([...fromTree, ...unassigned])
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[OrgChart] fetchOrgTree failed:', err)
        setError(classifyRequestError(err, '组织架构加载失败，请稍后重试。'))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    return loadData()
  }, [loadData])

  // 成员卡片显示「能否发起对话」：结合企业后台状态（暂停/下架/招募中）、人才市场是否上架和本机 readiness，
  // 不再显示服务端尚未提供的在线状态。只在员工集合变化时重新查询，调整部门后的静默刷新不会让状态闪回「检查中」。
  const [chatFacts, setChatFacts] = useState<Record<string, EmployeeChatFacts>>({})
  const employeeIdsKey = useMemo(() => [...new Set(rawEmps.map(emp => emp.employee_id))].sort().join('\n'), [rawEmps])
  useEffect(() => {
    if (!employeeIdsKey) return
    let cancelled = false
    const ids = employeeIdsKey.split('\n')
    void Promise.all([
      loadEmployeeReadiness(ids, id => agentApi.getExpertReadiness(id)),
      // 后台事实查不到时只按 readiness 判断，不影响成员卡片展示。
      loadEmployeeMarketFacts(ids).catch((err) => {
        console.warn('[OrgChart] load employee market facts failed:', err)
        return {} as Awaited<ReturnType<typeof loadEmployeeMarketFacts>>
      }),
    ]).then(([readiness, market]) => {
      if (cancelled) return
      setChatFacts(Object.fromEntries(ids.map(id => [id, { readiness: readiness[id], ...market[id] }])))
    })
    return () => { cancelled = true }
  }, [employeeIdsKey])

  const totalEmployees = useMemo(
    () => (stats ? stats.assigned_employee_count + stats.unassigned_employee_count : rawEmps.length),
    [stats, rawEmps],
  )

  const empsByDept = useMemo<Map<string, ApiEmployee[]>>(() => {
    // 子部门 ID 也必须视为合法归属，否则其员工会再次出现在“未分配部门”。
    return groupEmployeesByDepartment(departments, rawEmps)
  }, [rawEmps, departments])

  // 点击"对话"：打开该员工最近的会话，没有则新建
  const handleOpenChat = (emp: ApiEmployee) => {
    openEmployeeChat({ employeeId: emp.employee_id, displayName: emp.display_name }, navigate).catch((err) => {
      console.error('[OrgChart] open chat failed:', err)
      setMoveMessage({ tone: 'error', text: err instanceof Error ? `发起对话失败：${err.message}` : '发起对话失败，请稍后重试' })
    })
  }

  // 松手时的判断结果由 useDeptDrag 给出（规则见 dropIntent.ts）。
  // 先在页面上立即呈现结果，再保存到后台；保存失败则还原并提示，成功后静默同步服务端数据。
  const handleDrop = async (departmentId: string, intent: DropIntent, viaKeyboard: boolean) => {
    const action = intent.action
    if (!action) {
      // 停在不能放的位置时说明原因；没有目标或无需移动时安静地放回原处。
      if (intent.tone === 'blocked') setMoveMessage({ tone: 'error', text: intent.text })
      return
    }
    if (savingId) return
    const previous = departments
    revealRef.current = { id: departmentId, focus: viaKeyboard }
    setDepartments(action.departments)
    setSavingId(departmentId)
    setMoveMessage({ tone: 'saving', text: '正在保存部门调整…' })
    try {
      if (action.promoted) await promoteDepartmentRemote(departmentId, action.promoted)
      else await moveDepartmentRemote(departmentId, action.parentId)
      setMoveMessage({ tone: 'ok', text: action.success })
      setJustMovedId(departmentId)
      loadData(true)
    } catch (err) {
      setDepartments(previous)
      setMoveMessage({ tone: 'error', text: describeOrgError(err, '调整部门层级失败，已还原，请稍后重试') })
    } finally {
      setSavingId(null)
    }
  }

  const { draggingId, viaKeyboard, hover, intent, ghostRef, dndContextProps } = useDeptDrag({
    departments,
    canvasRef,
    onStart: () => setMoveMessage(null),
    onDrop: (departmentId, dropIntent, keyboard) => { void handleDrop(departmentId, dropIntent, keyboard) },
  })

  // 新部门树渲染后，把刚移动的部门滚到可见处；键盘操作时把焦点还给它，方便继续调整。
  useLayoutEffect(() => {
    const pending = revealRef.current
    if (!pending) return
    revealRef.current = null
    const node = canvasRef.current?.querySelector<HTMLElement>(`[data-org-drop="head"][data-dept-id="${CSS.escape(pending.id)}"]`)
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (pending.focus) node?.focus({ preventScroll: true })
  }, [departments])

  useEffect(() => {
    if (!justMovedId) return
    const timer = window.setTimeout(() => setJustMovedId(null), 1600)
    return () => window.clearTimeout(timer)
  }, [justMovedId])

  // 成功提示几秒后自动收起；出错提示留着，直到关闭或开始下一次拖动。
  useEffect(() => {
    if (moveMessage?.tone !== 'ok') return
    const timer = window.setTimeout(() => setMoveMessage(current => (current === moveMessage ? null : current)), 4000)
    return () => window.clearTimeout(timer)
  }, [moveMessage])

  const topDepts = useMemo(() => collectTopLevelCols(departments), [departments])
  const deptCount = stats?.department_count ?? topDepts.length

  // 跟随指针的拖动卡片上显示的部门信息；颜色沿用它所在顶级部门的颜色。
  const draggedCard = useMemo(() => {
    const dept = draggingId ? findDepartment(departments, draggingId)?.department : undefined
    if (!dept) return null
    const colIdx = topDepts.findIndex(d => d.department_id === dept.department_id || isAncestor(departments, d.department_id, dept.department_id))
    const subCount = dept.children?.length ?? 0
    return {
      name: dept.name,
      meta: `${collectDeptEmployees(dept).length} 人${subCount ? ` · ${subCount} 个下级部门` : ''}`,
      color: DEPT_COLORS[Math.max(colIdx, 0) % DEPT_COLORS.length],
    }
  }, [departments, draggingId, topDepts])

  // 拖动中的高亮：目标卡片按 mark 描边，松手后将要归属的部门（或公司根节点）整块铺底色。
  const landing = landingOf(intent)
  const markOf = (id: string) => (intent?.mark?.id === id ? intent.mark.style : null)
  const isAimed = (id: string) => viaKeyboard && hover?.kind === 'department' && hover.id === id
  // 只有有写权限、且是真实部门（不是“未设置”和“未分配部门”）才能拖动、重命名、删除，也才能作为放置目标。
  const editable = (dept: ApiDepartment | null) => writeAvailability.enabled && dept !== null && dept.department_id !== SERVER_UNASSIGNED_DEPARTMENT_ID
  const blockClass = (base: string, id: string) =>
    [base, landing === id && 'is-landing', draggingId === id && 'is-drag-origin'].filter(Boolean).join(' ')
  const deptNodeProps = (id: string, name: string, dept: ApiDepartment | null) => ({
    departmentId: id,
    name,
    enabled: editable(dept),
    locked: savingId !== null,
    mark: markOf(id),
    aimed: isAimed(id),
    saving: savingId === id,
    justMoved: justMovedId === id,
    onRename: () => setRenamingDept({ id, name }),
    onDelete: () => setDeletingDept({ id, name }),
  })

  const handleOpenMemberPopup = (
    emp: ApiEmployee,
    target: HTMLButtonElement,
    anchor?: { x: number; y: number },
  ) => {
    target.focus()
    const rect = target.getBoundingClientRect()
    setPopup({
      emp,
      x: anchor?.x ?? rect.right + 6,
      y: anchor?.y ?? rect.top,
    })
  }

  const handleFitScreen = useCallback(() => {
    const wrap = canvasWrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return

    const style = window.getComputedStyle(wrap)
    const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
    const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
    const nextZoom = calculateFitScale({
      contentWidth: canvas.offsetWidth,
      contentHeight: canvas.offsetHeight,
      viewportWidth: wrap.clientWidth - horizontalPadding,
      viewportHeight: wrap.clientHeight - verticalPadding,
    })
    setZoom(Number(nextZoom.toFixed(2)))
    wrap.scrollTo({ top: 0, left: 0 })
  }, [])

  // 渲染列 = 真实顶级部门(带子部门/子员工递归结构) + (若存在未分配员工则追加一列)
  interface RenderCol { id: string; name: string; dept: ApiDepartment | null; members: ApiEmployee[]; colorIdx: number }
  const renderCols = useMemo<RenderCol[]>(() => {
    const cols: RenderCol[] = topDepts.map((d, i) => ({
      id: d.department_id,
      name: d.name,
      dept: d,
      members: d.members ?? [],
      colorIdx: i,
    }))
    const unassigned = empsByDept.get(DEFAULT_DEPARTMENT_ID) ?? []
    if (unassigned.length > 0) {
      cols.push({ id: DEFAULT_DEPARTMENT_ID, name: '未分配部门', dept: null, members: unassigned, colorIdx: cols.length })
    }
    return cols
  }, [topDepts, empsByDept])

  // 成员节点渲染:抽出来复用于顶级列 + 递归子部门。
  // 原生右键复用真实会话入口；B8 未就绪的编辑/调动操作在菜单内保持禁用。
  const renderMember = (emp: ApiEmployee, color: string) => {
    const role = emp.position_title || emp.role_name || ''
    const chat = resolveEmployeeChatStatus(chatFacts[emp.employee_id] ?? {})
    return (
      <button
        type="button"
        key={`${emp.department_id ?? 'unassigned'}:${emp.employee_id}`}
        className="oc-member oc-member--clickable"
        onClick={e => {
          e.stopPropagation()
          handleOpenMemberPopup(emp, e.currentTarget)
        }}
        onContextMenu={e => {
          e.preventDefault()
          e.stopPropagation()
          handleOpenMemberPopup(emp, e.currentTarget, { x: e.clientX, y: e.clientY })
        }}
        onKeyDown={e => {
          if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return
          e.preventDefault()
          e.stopPropagation()
          handleOpenMemberPopup(emp, e.currentTarget)
        }}
        aria-haspopup="menu"
        aria-expanded={popup?.emp.employee_id === emp.employee_id}
        aria-keyshortcuts="Shift+F10"
        aria-label={`${emp.display_name}${role ? `，${role}` : ''}，${chat.label}${chat.tone === 'ok' || chat.state === 'checking' ? '' : `：${chat.detail}`}，打开员工操作`}
      >
        <div className="oc-member-avatar" style={{ borderColor: `${color}33` }}>
          <BotMessageSquare size={16} strokeWidth={1.6} style={{ color }} />
        </div>
        <div className="oc-member-info">
          <div className="oc-member-name">{emp.display_name}</div>
          {role && <div className="oc-member-role">{role}</div>}
          <div className={`oc-member-chat oc-member-chat--${chat.tone}`} title={chat.detail}>{chat.label}</div>
        </div>
      </button>
    )
  }

  // 递归渲染子部门:头部标注层级 + 该部门直属成员 + 再递归子部门。
  // depth=1 表示顶层部门(不由此函数渲染,由 renderCols 外层负责),此函数只处理 depth>=2 的子部门。
  // 外层块带 data-org-drop="body"：拖动时指在它的成员或空白处也算“放入这个部门”。
  const renderSubDept = (dept: ApiDepartment, color: string, depth: number) => {
    const id = dept.department_id
    const directMembers = dept.members ?? []
    const totalCount = collectDeptEmployees(dept).length
    const droppable = editable(dept)
    return (
      <div key={id} className={blockClass('oc-subdept', id)} data-org-drop={droppable ? 'body' : undefined} data-dept-id={droppable ? id : undefined} style={{ marginLeft: Math.min(depth - 2, 3) * 12 }}>
        <DeptDragNode {...deptNodeProps(id, dept.name, dept)} className="oc-subdept-header">
          <span className="oc-subdept-bar" style={{ background: color }} />
          <div className="oc-subdept-info">
            <div className="oc-subdept-name">{dept.name}</div>
            <div className="oc-subdept-meta">{totalCount} 人</div>
          </div>
        </DeptDragNode>
        {directMembers.map((emp) => renderMember(emp, color))}
        {(dept.children ?? []).map((child) => renderSubDept(child, color, depth + 1))}
      </div>
    )
  }

  return (
    <div className="oc">
      <p className="oc-intro">以树状可视化方式管理部门与 AI 员工，串联人才、聊天与办公室。</p>

      {/* ─── 统计卡片行 + 操作按钮 ─── */}
      <div className="oc-stats-wrap">
        <div className="oc-stats">
          <StatCard label="当前部门" value={loading || error ? '—' : deptCount} desc="与说明书一致的树状组织" />
          <StatCard label="AI 员工" value={loading || error ? '—' : totalEmployees} desc="来自人才市场 + 自定义员工" />
        </div>
        <div className="oc-btn-group">
          <button
            type="button"
            className="oc-btn oc-btn--brand"
            aria-describedby={writeAvailability.enabled ? undefined : 'oc-write-disabled-reason'}
            disabled={isWriteActionDisabled(writeAvailability)}
            title={writeAvailability.reason || undefined}
            onClick={() => setCreatingDept(true)}
          >
            <Plus size={13} strokeWidth={2} />
            添加部门
          </button>
        </div>
      </div>

      {!writeAvailability.enabled && (
        <div id="oc-write-disabled-reason" className="oc-service-notice" role="status">
          {writeAvailability.reason}
        </div>
      )}

      {/* ─── 画布区 header ─── */}
      <div className="oc-header">
        <div>
          <div className="oc-title">横向思维导图组织架构</div>
          <div className="oc-subtitle">采用一层一层向右展开的思维导图形式，强化部门与员工的层级脉络。</div>
          {writeAvailability.enabled && (
            <div className="oc-subtitle oc-drag-hint">拖动部门卡片调整层级：放在卡片上成为下级，放在卡片下沿成为同级，放在公司卡片上设为顶级。</div>
          )}
        </div>
        <div className="oc-controls" role="group" aria-label="组织架构缩放控制">
          <button
            type="button"
            className="oc-ctrl"
            onClick={() => setZoom(z => Math.max(0.5, +(z - 0.1).toFixed(1)))}
            aria-label="缩小组织架构"
            title="缩小"
            aria-controls="org-chart-canvas"
          >
            <Minus size={13} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="oc-ctrl"
            onClick={() => setZoom(z => Math.min(2, +(z + 0.1).toFixed(1)))}
            aria-label="放大组织架构"
            title="放大"
            aria-controls="org-chart-canvas"
          >
            <Plus size={13} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="oc-ctrl"
            onClick={handleFitScreen}
            aria-label="适应屏幕"
            title={`适应屏幕（当前 ${Math.round(zoom * 100)}%）`}
            aria-controls="org-chart-canvas"
          >
            <Maximize2 size={13} strokeWidth={1.8} />
          </button>
          <span className="oc-zoom-value" role="status" aria-live="polite">{Math.round(zoom * 100)}%</span>
        </div>
      </div>

      {/* ─── 画布 ─── */}
      <div className="oc-canvas-wrap" id="org-chart-canvas" ref={canvasWrapRef} role="region" aria-label="组织架构图">
        {loading && <div className="oc-empty">加载组织架构中…</div>}
        {!loading && error && (
          <RequestErrorState error={error} onRetry={() => void loadData()} />
        )}
        {!loading && !error && (
          <DndContext {...dndContextProps}>
          <div ref={canvasRef} className={`oc-canvas${draggingId ? ' is-dragging' : ''}`} style={{ transform: `scale(${zoom})` }}>
            {/* 根节点：拖动时也是放置目标，放上去＝设为顶级部门。 */}
            <div
              className={`oc-root${landing === ROOT_DROP_ID ? ' is-landing' : ''}`}
              data-org-drop="root"
              data-drop={markOf(ROOT_DROP_ID) ?? undefined}
              data-aim={viaKeyboard && hover?.kind === 'root' ? '' : undefined}
            >
              <div className="oc-root-icon">
                <Building2 size={20} strokeWidth={1.6} />
              </div>
              <div>
                <div className="oc-root-name">{enterprise?.name || '我的企业'}</div>
                <div className="oc-root-sub">公司根节点 · AI Native Organization</div>
              </div>
              <div className="oc-root-badge">{totalEmployees} 名 AI 员工</div>
            </div>

            {renderCols.length > 0 && <div className="oc-stem" />}

            {renderCols.length > 0 && (
              <div className="oc-row">
                {renderCols.map((col) => {
                  const color = DEPT_COLORS[col.colorIdx % DEPT_COLORS.length]
                  // 顶层列的角色标签与总人数按整棵子树聚合,避免只统计直属员工造成失真。
                  const allEmps = col.dept ? collectDeptEmployees(col.dept) : col.members
                  const roleSet = new Set(allEmps.map(e => e.position_title || e.role_name).filter(Boolean))
                  const roleTags = [...roleSet].slice(0, 3).join(' / ')
                  const droppable = editable(col.dept)
                  return (
                    // 部门原生右键菜单只会包含 B8 写操作，接口就绪前保持不挂载。
                    <div key={col.id} className={blockClass('oc-col', col.id)} data-org-drop={droppable ? 'body' : undefined} data-dept-id={droppable ? col.id : undefined}>
                      <DeptDragNode {...deptNodeProps(col.id, col.name, col.dept)} className="oc-dept">
                        <div className="oc-dept-bar" style={{ background: color }} />
                        <div>
                          <div className="oc-dept-name">{col.name}</div>
                          <div className="oc-dept-meta">
                            {allEmps.length} 人{roleTags ? ` · ${roleTags}` : ''}
                          </div>
                        </div>
                      </DeptDragNode>

                      {/* 直属员工先展示,子部门在其下方依次向内缩进渲染(设计文档 6.x - 多级部门递归)。 */}
                      {col.members.map((emp) => renderMember(emp, color))}
                      {(col.dept?.children ?? []).map((child) => renderSubDept(child, color, 2))}
                    </div>
                  )
                })}
              </div>
            )}

            {renderCols.length === 0 && (
              <div className="oc-empty">暂无员工数据</div>
            )}
          </div>
          {draggingId && intent && draggedCard && (
            <DeptDragGhost ref={ghostRef} name={draggedCard.name} meta={draggedCard.meta} color={draggedCard.color} intent={intent} viaKeyboard={viaKeyboard} />
          )}
          </DndContext>
        )}
      </div>

      {renamingDept && (
        <RenameDeptDialog
          department={renamingDept}
          departments={departments}
          onClose={() => setRenamingDept(null)}
          onRenamed={async (next, name) => {
            await renameDepartmentRemote(renamingDept.id, name)
            setDepartments(next)
            setMoveMessage({ tone: 'ok', text: '已重命名部门' })
            loadData(true)
          }}
        />
      )}
      {deletingDept && (
        <DeleteDeptDialog
          department={deletingDept}
          onClose={() => setDeletingDept(null)}
          onConfirm={async () => {
            await deleteDepartmentRemote(deletingDept.id)
            setMoveMessage({ tone: 'ok', text: '已删除部门' })
            loadData(true)
          }}
        />
      )}
      {creatingDept && <CreateDeptDialog departments={departments} onClose={() => setCreatingDept(false)} onCreated={() => { loadData() }} />}
      {assigningEmployee && <AssignDepartmentDialog emp={assigningEmployee} departments={departments} onClose={() => setAssigningEmployee(null)} onSaved={() => { loadData() }} />}
      {popup && (
        <MemberActionPopup
          anchor={{ x: popup.x, y: popup.y }}
          onClose={() => setPopup(null)}
          onChat={() => handleOpenChat(popup.emp)}
          assignDisabledReason={writeAvailability.reason}
          onAssign={() => { setAssigningEmployee(popup.emp); setPopup(null) }}
        />
      )}
      {/* 键盘拖动时播报“此刻松手会怎样”；指针拖动的说明已在拖动卡片上，不重复播报。 */}
      <div className="oc-sr-only" aria-live="polite" aria-atomic="true">{viaKeyboard && intent ? intent.text : ''}</div>
      {moveMessage && <OrgToast notice={moveMessage} onClose={() => setMoveMessage(null)} />}
    </div>
  )
}
