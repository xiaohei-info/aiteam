import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ShieldCheck, Zap } from 'lucide-react'
import './ChatTools.css'
import { agentApi } from '../../api/agent'
import { openFilePrivacySettings } from '../../lib/fileAccess'
import { directoryEmployeeIdOf, permissionSummary } from '../../lib/conversationPermissions'
import type { ConversationMetadata } from '../../api/agent/types'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import { ChatDialog } from './ChatDialog'
import { ConversationDirectories, useConversationDirectories } from './ConversationDirectories'

interface ConversationPermissionsProps {
  conversationId: string
  generating: boolean
  ensureConversation: () => Promise<{ id: string }>
}
const grants = ['读取和修改工作区外的文件', '执行本机命令', '访问网络']

/**
 * 聊天输入框下方的「权限」入口：一个按钮汇总状态，面板内分「本会话的权限」「员工可检索的目录」「系统层」三段。
 * 会话权限与目录检索仍是两项独立设置，切换其一不影响另一项。
 */
export function ConversationPermissions({ conversationId, generating, ensureConversation }: ConversationPermissionsProps) {
  const [metadata, setMetadata] = useState<ConversationMetadata | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [accepted, setAccepted] = useState<boolean[]>(grants.map(() => false))
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const permissionRevision = useRef(0)
  const activeId = useRef(conversationId)
  activeId.current = conversationId
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const modeTitleId = useId()
  useEffect(() => {
    let cancelled = false
    const revision = permissionRevision.current
    setConfirm(false); setMetadata(null); setError('')
    if (conversationId.startsWith('emp_')) return
    agentApi.getConversation(conversationId)
      .then(result => { if (!cancelled && permissionRevision.current === revision) setMetadata(result) })
      .catch(() => { if (!cancelled) setError('会话权限读取失败') })
    return () => { cancelled = true }

  }, [conversationId, generating, attempt])
  useEffect(() => { setOpen(false) }, [conversationId])

  const handlePermission = async (full: boolean) => {
    if (saving) return
    const sourceId = conversationId
    setSaving(true); setError('')
    try {
      const conversation = await ensureConversation()
      const updated = await agentApi.updateConversation(conversation.id, { permission_mode: full ? 'full-access' : 'read-only' })
      if (activeId.current === sourceId || activeId.current === conversation.id) {
        permissionRevision.current += 1
        setMetadata(updated); setConfirm(false)
      }
    } catch { if (activeId.current === sourceId) setError('权限更新失败，请重试') }
    finally { setSaving(false) }
  }
  const full = metadata?.permission_mode === 'full-access'
  const group = metadata?.kind === 'group'
  const directoryEmployeeId = directoryEmployeeIdOf(conversationId, metadata)
  const directories = useConversationDirectories(directoryEmployeeId)
  const { busy: directoriesBusy, cancelRemove } = directories
  const modeDisabled = saving || generating || (!metadata && !conversationId.startsWith('emp_'))

  // 目录操作进行中（如原生选择器未关闭）不收起面板，保证结果反馈能回到面板里。
  const closePanel = useCallback(() => {
    if (directoriesBusy) return
    setOpen(false); cancelRemove()
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }, [directoriesBusy, cancelRemove])
  const panelRef = useDialogFocus<HTMLDivElement>({ active: open })
  // 确认弹窗打开时由弹窗接管关闭快捷键和点击，面板保持展开，弹窗关闭后焦点回到面板。
  useGlobalShortcutClose({ active: open && !confirm, onClose: closePanel })
  useEffect(() => {
    if (!open || confirm) return
    const handler = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) closePanel()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, confirm, closePanel])

  const togglePanel = () => {
    if (open) { closePanel(); return }
    directories.refresh(); setOpen(true)
  }
  const chooseFullAccess = () => {
    if (full) return
    setAccepted(grants.map(() => false)); setConfirm(true)
  }
  const openSystemSettings = () => void openFilePrivacySettings().catch(() => setError('无法打开系统设置，请手动前往 系统设置 → 隐私与安全性 → 完全磁盘访问权限'))

  return <div className="chat-conversation-status">
    <div className="chat-status-line">
      <div className="chat-status-actions cperm" ref={rootRef}>
        <button
          ref={triggerRef}
          type="button"
          className={`cperm-trigger${full ? ' full' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label={`权限：${permissionSummary(full, directories.enabledCount)}`}
          onClick={togglePanel}
        >
          {full ? <Zap size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
          <span>{permissionSummary(full, directories.enabledCount)}</span>
          <ChevronDown size={13} className="cperm-chevron" aria-hidden="true" />
        </button>
        {open && <div
          ref={panelRef}
          id={panelId}
          className="cperm-panel"
          role="dialog"
          aria-label="权限"
          tabIndex={-1}
          onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); closePanel() } }}
        >
          <section className="cperm-section" aria-labelledby={modeTitleId}>
            <div className="cdir-section-head"><span id={modeTitleId}>本会话的权限</span></div>
            <div className="cperm-modes" role="radiogroup" aria-labelledby={modeTitleId}>
              <button type="button" role="radio" aria-checked={!full} className="cperm-mode" disabled={modeDisabled} data-dialog-initial-focus={!full || undefined} onClick={() => { if (full) void handlePermission(false) }}>
                <span className="cperm-radio" aria-hidden="true" />
                <span className="cperm-mode-text"><strong>只读</strong><small>员工只能读取工作区内的文件</small></span>
              </button>
              <button type="button" role="radio" aria-checked={full} className="cperm-mode risky" disabled={modeDisabled} data-dialog-initial-focus={full || undefined} onClick={chooseFullAccess}>
                <span className="cperm-radio" aria-hidden="true" />
                <span className="cperm-mode-text"><strong>完全访问<em>风险较高</em></strong><small>执行本机命令、读写任意位置、访问网络 · 仅对本会话生效，需逐项确认</small></span>
              </button>
            </div>
            {generating && <p className="cperm-hint">回复生成中，暂不能切换会话权限。</p>}
          </section>
          <ConversationDirectories controller={directories} employeeId={directoryEmployeeId} group={group} generating={generating} />
          <div className="cperm-system">
            <span>系统层：桌面、文稿等受保护位置被系统拦截时，需为 AIFred 开启「完全磁盘访问权限」。</span>
            <button type="button" className="chat-link-button" onClick={openSystemSettings}>打开系统设置</button>
          </div>
        </div>}
      </div>
    </div>
    {error && <p role="alert">{error} <button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></p>}
    {confirm && <ChatDialog title="授权完全访问" onClose={() => { if (!saving) setConfirm(false) }}>
      <p className="chat-tools-note">为当前会话开放以下全部权限。开启后，助手执行本机命令和读写文件无需逐次确认；调用外部连接器等其他工具仍会请求你的批准。</p>
      {grants.map((grant, index) => <label className="chat-permission-grant" key={grant}><input type="checkbox" checked={accepted[index]} disabled={saving} onChange={event => setAccepted(previous => previous.map((value, i) => i === index ? event.target.checked : value))} />{grant}</label>)}
      <p className="chat-tools-note">此开关只放开本会话的沙箱限制，不等同于 macOS 的“完全磁盘访问权限”；若员工读写桌面、文稿等受保护目录被系统拦截，请在系统设置中为 AIFred 开启该权限。<button type="button" className="chat-link-button" onClick={openSystemSettings}>打开系统设置</button> 选回「只读」即恢复只读权限。</p>
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" disabled={saving} onClick={() => setConfirm(false)}>取消</button><button type="button" disabled={saving || !accepted.every(Boolean)} onClick={() => void handlePermission(true)}>{saving ? '授权中…' : '授权全部并开启'}</button></footer>
    </ChatDialog>}
  </div>
}
