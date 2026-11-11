import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useMergeRefs } from '@floating-ui/react'
import { invoke } from '@tauri-apps/api/core'
import { ChevronDown, FolderCog, FolderOpen, FolderSearch, LoaderCircle, ShieldCheck, Zap } from 'lucide-react'
import './ChatTools.css'
import { agentApi } from '../../api/agent'
import { openFilePrivacySettings } from '../../lib/fileAccess'
import { conversationWorkspaceKey, FULL_ACCESS_GRANTS as grants, isDraftConversation, isWindowsUserAgent, permissionSummary } from '../../lib/conversationPermissions'
import { isMacUserAgent } from '../../lib/projectConversation'
import { describeProjectFolderError } from '../../lib/projectConversation'
import type { ConversationMetadata, PermissionMode } from '../../api/agent/types'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import { PopoverPortal } from '../Popover/PopoverLayer'
import { useAnchoredPopover } from '../Popover/useAnchoredPopover'
import { ChatDialog } from './ChatDialog'
import { ConversationDirectories, useConversationDirectories } from './ConversationDirectories'

interface ConversationPermissionsProps {
  conversationId: string
  generating: boolean
  ensureConversation: () => Promise<{ id: string }>
}
/**
 * 档位说明。Windows 没有已验证的沙箱后端：三档都不隔离文件与网络，只有逐次审批的严格程度不同，
 * 所以说明必须写实际行为，避免用户按 macOS 的预期理解「只读」。
 */
function modeDescription(mode: PermissionMode, windows: boolean): string {
  if (windows) {
    return mode === 'read-only'
      ? '不隔离文件与网络；命令需确认，写操作被拒'
      : mode === 'workspace-write'
        ? '不隔离文件与网络；命令与写操作需确认'
        : '不隔离文件与网络；命令与写操作不再确认'
  }
  return mode === 'read-only'
    ? '只能读文件'
    : mode === 'workspace-write'
      ? '可读写，操作前需确认，不联网'
      : '不受限，可联网'
}

/** 路径过长时在中间省略：开头尽量多留，结尾固定保留最后两段，鼠标悬停看全路径。 */
function FolderPath({ path, fallback }: { path?: string; fallback: string }) {
  if (!path) return <code>{fallback}</code>
  const trimmed = path.replace(/[\\/]+$/, '')
  const last = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const cut = last > 0 ? Math.max(trimmed.lastIndexOf('/', last - 1), trimmed.lastIndexOf('\\', last - 1)) + 1 : 0
  return <code className="cperm-path"><span className="cperm-path-head">{trimmed.slice(0, cut)}</span><span className="cperm-path-tail">{trimmed.slice(cut)}</span></code>
}
/**
 * 聊天输入框下方的「权限」入口：一个按钮汇总状态，面板内分「本会话的目录」「本会话的权限」「系统层」三段。
 * 「本会话的目录」把工作目录和本会话添加的目录放在一起；「本会话的权限」三档对这些目录同样生效。都只对本会话生效。
 */
export function ConversationPermissions({ conversationId, generating, ensureConversation }: ConversationPermissionsProps) {
  const [metadata, setMetadata] = useState<ConversationMetadata | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [accepted, setAccepted] = useState<boolean[]>(grants.map(() => false))
  const [saving, setSaving] = useState(false)
  const [moving, setMoving] = useState(false)
  const [folderError, setFolderError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [managedFolder, setManagedFolder] = useState<{ key: string; path: string } | null>(null)
  const permissionRevision = useRef(0)
  const activeId = useRef(conversationId)
  activeId.current = conversationId
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const modeTitleId = useId()
  const foldersTitleId = useId()
  useEffect(() => {
    let cancelled = false
    const revision = permissionRevision.current
    setConfirm(false); setMetadata(null); setError(''); setFolderError('')
    if (conversationId.startsWith('emp_')) return
    agentApi.getConversation(conversationId)
      .then(result => { if (!cancelled && permissionRevision.current === revision) setMetadata(result) })
      .catch(() => { if (!cancelled) setError('会话权限读取失败') })
    return () => { cancelled = true }

  }, [conversationId, generating, attempt])
  useEffect(() => { setOpen(false) }, [conversationId])

  const handlePermission = async (next: PermissionMode) => {
    if (saving) return
    const sourceId = conversationId
    setSaving(true); setError('')
    try {
      const conversation = await ensureConversation()
      const updated = await agentApi.updateConversation(conversation.id, { permission_mode: next })
      if (activeId.current === sourceId || activeId.current === conversation.id) {
        permissionRevision.current += 1
        setMetadata(updated); setConfirm(false)
      }
    } catch { if (activeId.current === sourceId) setError('权限更新失败，请重试') }
    finally { setSaving(false) }
  }
  const mode: PermissionMode = metadata?.permission_mode ?? 'read-only'
  const full = mode === 'full-access'
  const projectPath = metadata?.project?.path
  const group = metadata?.kind === 'group'
  const directories = useConversationDirectories(conversationId, ensureConversation)
  const entryEmployeeId = metadata?.entry_employee_id ?? null
  // 受管工作目录的真实路径：前端只拿目录名，路径由桌面宿主解析；项目对话自带 project.path，不用取。
  useEffect(() => {
    setManagedFolder(null)
    if (!open || !metadata || projectPath || isDraftConversation(conversationId)) return
    let cancelled = false
    void (async () => {
      try {
        const { conversations } = await agentApi.listWorkspaces()
        const key = conversationWorkspaceKey(conversations.find(item => item.conversation_id === metadata.id), entryEmployeeId)
        if (!key) return
        const path = await invoke<string>('fred_workspace_path', { workspaceKey: key })
        if (!cancelled) setManagedFolder({ key, path })
      } catch { /* 取不到路径时保留原有文字，不打扰用户 */ }
    })()
    return () => { cancelled = true }
  }, [open, metadata?.id, projectPath, conversationId, entryEmployeeId])
  const { busy: directoriesBusy } = directories
  const modeDisabled = saving || generating || (!metadata && !conversationId.startsWith('emp_'))

  // 目录操作进行中（如原生选择器未关闭）不收起面板，保证结果反馈能回到面板里。
  const closePanel = useCallback(() => {
    if (directoriesBusy || moving) return
    setOpen(false)
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }, [directoriesBusy, moving])
  const panelRef = useDialogFocus<HTMLDivElement>({ active: open })
  // 面板贴在按钮上方左对齐，渲染到 body 并跟随按钮位置（见 useAnchoredPopover）；焦点仍由 useDialogFocus 管。
  const popover = useAnchoredPopover({ open, placement: 'top-start', fit: { maxWidth: 400, maxHeight: 560 } })
  const triggerRefs = useMergeRefs([triggerRef, popover.refs.setReference])
  const panelRefs = useMergeRefs([panelRef, popover.refs.setFloating])
  // 确认弹窗打开时由弹窗接管关闭快捷键和点击，面板保持展开，弹窗关闭后焦点回到面板。
  useGlobalShortcutClose({ active: open && !confirm, onClose: closePanel })
  useEffect(() => {
    if (!open || confirm) return
    const handler = (event: MouseEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return
      closePanel()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, confirm, closePanel, panelRef])

  const togglePanel = () => {
    if (open) { closePanel(); return }
    directories.refresh(); setOpen(true)
  }
  // 项目搬家后：宿主弹出文件夹选择框并签发一次性票据，Agent 凭票据更换工作目录；前端从不提交路径。
  const relocateProject = async () => {
    if (!metadata || !projectPath || moving || generating) return
    const sourceId = metadata.id
    setMoving(true); setFolderError('')
    try {
      const challenge = await agentApi.createLocalDirectoryChallenge()
      const { ticket } = await invoke<{ ticket: string }>('select_project_folder', { challenge, defaultPath: projectPath })
      const updated = await agentApi.setConversationProjectFolder(sourceId, ticket)
      if (activeId.current === sourceId) { permissionRevision.current += 1; setMetadata(updated) }
    } catch (err) {
      if (activeId.current === sourceId) setFolderError(describeProjectFolderError(err))
    } finally { setMoving(false) }
  }
  const revealFolder = async () => {
    const target = managedFolder
      ? { source: 'fred', projectId: managedFolder.key }
      : metadata?.project?.id ? { source: metadata.project.source, projectId: metadata.project.id } : null
    if (!target) return
    setFolderError('')
    try { await invoke('open_project_file', { ...target, fileId: null, reveal: true }) }
    catch { setFolderError('无法打开该文件夹，可能已被移动或删除') }
  }
  const canReveal = Boolean(managedFolder || (projectPath && metadata?.project?.id))
  const revealLabel = isMacUserAgent(navigator.userAgent) ? '在 Finder 中显示' : '在文件夹中显示'
  const windows = isWindowsUserAgent(navigator.userAgent)
  const chooseFullAccess = () => {
    if (full) return
    setAccepted(grants.map(() => false)); setConfirm(true)
  }
  const openSystemSettings = () => void openFilePrivacySettings().catch(() => setError('无法打开系统设置，请手动前往 系统设置 → 隐私与安全性 → 完全磁盘访问权限'))

  return <div className="chat-conversation-status">
    <div className="chat-status-line">
      <div className="chat-status-actions cperm" ref={rootRef}>
        <button
          ref={triggerRefs}
          type="button"
          className={`cperm-trigger${full ? ' full' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label={`权限：${permissionSummary(mode, directories.enabledCount)}`}
          onClick={togglePanel}
        >
          {full ? <Zap size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
          <span>{permissionSummary(mode, directories.enabledCount)}</span>
          <ChevronDown size={13} className="cperm-chevron" aria-hidden="true" />
        </button>
        {open && <PopoverPortal><div
          ref={panelRefs}
          id={panelId}
          className="cperm-panel"
          style={popover.floatingStyles}
          role="dialog"
          aria-label="权限"
          tabIndex={-1}
          onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); closePanel() } }}
        >
          <section className="cperm-section" aria-labelledby={foldersTitleId}>
            <div className="cdir-section-head">
              <span id={foldersTitleId}>本会话的目录</span>
              {directories.enabledCount > 0 && <span>另加 {directories.enabledCount} 个</span>}
            </div>
            <div className="cperm-folder-block">
              <div className="cperm-folder" title={projectPath ?? managedFolder?.path}>
                <FolderOpen size={16} aria-hidden="true" />
                <div className="cperm-folder-meta">
                  <span>{projectPath ? '工作目录（项目所在文件夹）' : '工作目录'}</span>
                  <FolderPath path={projectPath ?? managedFolder?.path} fallback={group ? '全群共用的文件夹' : '由 AIFred 管理'} />
                </div>
                <div className="cperm-folder-actions">
                  {canReveal && <button type="button" className="cdir-icon" title={revealLabel} aria-label={revealLabel} onClick={() => void revealFolder()}>
                    <FolderSearch size={14} aria-hidden="true" />
                  </button>}
                  {projectPath && <button type="button" className="cdir-add" disabled={moving || generating} onClick={() => void relocateProject()}>
                    {moving ? <LoaderCircle size={14} className="cdir-spinner" aria-hidden="true" /> : <FolderCog size={14} aria-hidden="true" />}
                    更换目录
                  </button>}
                </div>
              </div>
              {folderError && <p className="cdir-notice err" role="alert"><span>{folderError}</span></p>}
            </div>
            <ConversationDirectories controller={directories} generating={generating} />
          </section>
          <section className="cperm-section" aria-labelledby={modeTitleId}>
            <div className="cdir-section-head"><span id={modeTitleId}>本会话的权限</span></div>
            <div className="cperm-modes" role="radiogroup" aria-labelledby={modeTitleId}>
              <button type="button" role="radio" aria-checked={mode === 'read-only'} className="cperm-mode" disabled={modeDisabled} data-dialog-initial-focus={mode === 'read-only' || undefined} onClick={() => { if (mode !== 'read-only') void handlePermission('read-only') }}>
                <span className="cperm-radio" aria-hidden="true" />
                <span className="cperm-mode-text"><strong>只读</strong><small>{modeDescription('read-only', windows)}</small></span>
              </button>
              <button type="button" role="radio" aria-checked={mode === 'workspace-write'} className="cperm-mode" disabled={modeDisabled} data-dialog-initial-focus={mode === 'workspace-write' || undefined} onClick={() => { if (mode !== 'workspace-write') void handlePermission('workspace-write') }}>
                <span className="cperm-radio" aria-hidden="true" />
                <span className="cperm-mode-text"><strong>工作区可写</strong><small>{modeDescription('workspace-write', windows)}</small></span>
              </button>
              <button type="button" role="radio" aria-checked={full} className="cperm-mode risky" disabled={modeDisabled} data-dialog-initial-focus={full || undefined} onClick={chooseFullAccess}>
                <span className="cperm-radio" aria-hidden="true" />
                <span className="cperm-mode-text"><strong>完全访问<em>风险较高</em></strong><small>{modeDescription('full-access', windows)}</small></span>
              </button>
            </div>
            {windows && <p className="cperm-hint">Windows 上暂不提供文件与网络隔离，三档只影响逐次确认</p>}
            {generating && <p className="cperm-hint">回复中，暂不能修改</p>}
          </section>
          <div className="cperm-system">
            <span>桌面、文稿需开启完全磁盘访问</span>
            <button type="button" className="chat-link-button" onClick={openSystemSettings}>打开系统设置</button>
          </div>
        </div></PopoverPortal>}
      </div>
    </div>
    {error && <p role="alert">{error} <button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></p>}
    {confirm && <ChatDialog title="授权完全访问" onClose={() => { if (!saving) setConfirm(false) }}>
      <p className="chat-tools-note">仅对本会话生效，可随时改回。开启后员工运行命令、读写文件不再逐次确认，外部连接器仍需你批准。</p>
      {grants.map((grant, index) => <label className="chat-permission-grant" key={grant}><input type="checkbox" checked={accepted[index]} disabled={saving} onChange={event => setAccepted(previous => previous.map((value, i) => i === index ? event.target.checked : value))} />{grant}</label>)}
      <p className="chat-tools-note">桌面、文稿等受保护位置还需在系统设置里开启「完全磁盘访问权限」。<button type="button" className="chat-link-button" onClick={openSystemSettings}>打开系统设置</button></p>
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" disabled={saving} onClick={() => setConfirm(false)}>取消</button><button type="button" disabled={saving || !accepted.every(Boolean)} onClick={() => void handlePermission('full-access')}>{saving ? '授权中…' : '授权全部并开启'}</button></footer>
    </ChatDialog>}
  </div>
}
