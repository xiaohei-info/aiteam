import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CircleAlert, CircleCheck, Folder, FolderOpen, FolderPlus, LoaderCircle, Trash2 } from 'lucide-react'
import './ChatTools.css'
import './ConversationDirectories.css'
import { agentApi, AgentApiError, isRevisionConflict } from '../../api/agent'
import type { LocalDirectory } from '../../api/agent'
import { invokeErrorText, localDirectoryApiErrorText, statusLabel } from './localDirectoryErrors'

/**
 * 对话窗口内的本地目录授权：选目录与「允许当前员工检索」一步完成。
 * 目录授权、绑定都只走本机 Agent，不依赖企业 Manager / NAS 连接。
 * 状态放在权限按钮所在的组件里，面板收起时按钮仍能汇总已开启的目录数。
 */
export function useConversationDirectories(employeeId: string | null) {
  const [supported, setSupported] = useState(false)
  const [directories, setDirectories] = useState<LocalDirectory[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  // 移除授权对所有员工生效，需二次确认；同一时间只会有一个目录处于待确认态。
  const [pendingRemoveId, setPendingRemoveId] = useState('')
  const activeRef = useRef(true)
  const busyRef = useRef(false)

  useEffect(() => {
    activeRef.current = true
    return () => { activeRef.current = false }
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const payload = await agentApi.listLocalDirectories()
      if (activeRef.current) setDirectories(payload.directories)
    } catch (err) {
      if (activeRef.current) setError(localDirectoryApiErrorText(err))
    } finally {
      if (activeRef.current) setLoading(false)
    }
  }, [])

  // 旧版内嵌 Agent 没有本地目录接口时隐藏目录段；就绪后静默读取一次用于展示已授权数量。
  useEffect(() => {
    let active = true
    agentApi.supportsLocalDirectories().then(ok => {
      if (!active) return
      setSupported(ok)
      if (ok) void load()
    }).catch(() => { if (active) setSupported(false) })
    return () => { active = false }
  }, [load])

  const bindingOf = (directory: LocalDirectory) => directory.bindings.find(item => item.employee_id === employeeId)
  const enabledCount = employeeId ? directories.filter(directory => bindingOf(directory)?.enabled).length : 0

  async function run(task: () => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(''); setFeedback('')
    try {
      await task()
    } catch (err) {
      if (!activeRef.current) return
      if (err instanceof AgentApiError && isRevisionConflict(err)) {
        await load()
        setError('授权刚被其他窗口修改，列表已刷新，请重试。')
      } else if (err instanceof AgentApiError) setError(localDirectoryApiErrorText(err))
      else setError(invokeErrorText(err))
    } finally {
      busyRef.current = false
      if (activeRef.current) setBusy(false)
    }
  }

  const toggle = (directory: LocalDirectory) => run(async () => {
    if (!employeeId) return
    setPendingRemoveId('')
    const binding = bindingOf(directory)
    const enabled = !binding?.enabled
    await agentApi.setLocalDirectoryBinding(directory.directory_id, employeeId, enabled, binding?.revision ?? 0)
    if (!activeRef.current) return
    setFeedback(enabled ? `已允许当前员工检索「${directory.display_name}」。` : `已取消检索「${directory.display_name}」，在途访问立即中止。`)
    await load()
  })

  const addDirectory = () => run(async () => {
    if (!employeeId) return
    setPendingRemoveId('')
    const challenge = await agentApi.createLocalDirectoryChallenge()
    const selection = await invoke<{ ticket: string }>('select_local_knowledge_directory', { challenge })
    const registered = await agentApi.registerLocalDirectory(selection.ticket)
    // 刚授权的目录立即对当前员工生效，省去再去员工详情绑定的一步。
    await agentApi.setLocalDirectoryBinding(registered.directory_id, employeeId, true, 0)
    if (!activeRef.current) return
    setFeedback(`已授权「${registered.display_name}」，之后在私聊里提问时会自动查找其中的资料。`)
    await load()
  })

  const remove = (directory: LocalDirectory) => {
    // 两段式确认：第一次点击进入待确认态，再次点击才真正移除。
    if (pendingRemoveId !== directory.directory_id) { setPendingRemoveId(directory.directory_id); return }
    setPendingRemoveId('')
    void run(async () => {
      await agentApi.revokeLocalDirectory(directory.directory_id)
      if (!activeRef.current) return
      setFeedback(`已移除「${directory.display_name}」，所有员工都不能再检索它，在途检索已中止。`)
      await load()
    })
  }

  /** 面板展开时清掉上一次的反馈并刷新列表。 */
  const refresh = () => { setFeedback(''); setPendingRemoveId(''); if (supported) void load() }
  const cancelRemove = useCallback(() => setPendingRemoveId(''), [])

  return { supported, directories, loading, busy, error, feedback, pendingRemoveId, enabledCount, bindingOf, toggle, addDirectory, remove, refresh, cancelRemove }
}

export type ConversationDirectoriesController = ReturnType<typeof useConversationDirectories>

interface ConversationDirectoriesProps {
  controller: ConversationDirectoriesController
  /** 当前会话的入口员工；尚无员工信息时不渲染。 */
  employeeId: string | null
  /** 群聊不检索目录：目录段置灰并说明，不隐藏。 */
  group: boolean
  generating: boolean
}

/** 权限面板里的「员工可检索的目录」一段。 */
export function ConversationDirectories({ controller, employeeId, group, generating }: ConversationDirectoriesProps) {
  const { supported, directories, loading, busy, error, feedback, pendingRemoveId, enabledCount, bindingOf, toggle, addDirectory, remove } = controller
  const titleId = useId()
  if (!supported || (!employeeId && !group)) return null

  if (group || !employeeId) return <section className="cperm-section cdir-section disabled" aria-labelledby={titleId}>
    <div className="cdir-section-head"><span id={titleId}>员工可检索的目录</span></div>
    <p className="cperm-hint">群聊暂不支持目录检索。目录只在和员工的私聊里生效。</p>
  </section>

  return <section className="cperm-section cdir-section" aria-labelledby={titleId}>
    <div className="cdir-section-head">
      <span id={titleId}>员工可检索的目录（对当前员工生效）</span>
      {directories.length > 0 && <span>{enabledCount} / {directories.length} 已开启</span>}
    </div>

    {loading && !directories.length ? <p className="cdir-loading" role="status"><LoaderCircle size={14} className="cdir-spinner" aria-hidden="true" />正在读取目录…</p>
      : !directories.length ? <p className="cdir-empty">还没有授权目录。添加一个文件夹，当前员工就能在私聊里用到其中的资料。</p>
      : <ul className="cdir-list">
        {directories.map(directory => {
          const enabled = Boolean(bindingOf(directory)?.enabled)
          const ready = directory.status === 'ready'
          const confirming = pendingRemoveId === directory.directory_id
          return <li key={directory.directory_id} className={`cdir-item${enabled ? ' enabled' : ''}${ready ? '' : ' unavailable'}`}>
            <span className="cdir-icon">{enabled ? <FolderOpen size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}</span>
            <div className="cdir-meta">
              <div className="cdir-name">
                <strong title={directory.display_name}>{directory.display_name}</strong>
                {!ready && <span className="cdir-badge bad">{statusLabel(directory.status)}</span>}
              </div>
              <code title={directory.path}>{directory.path}</code>
            </div>
            <button
              type="button"
              className={`cdir-remove${confirming ? ' confirm' : ''}`}
              disabled={busy}
              title="移除授权（所有员工都将不能再检索该目录）"
              aria-label={confirming ? `确认移除 ${directory.display_name} 的授权，所有员工都将无法检索` : `移除 ${directory.display_name} 的授权`}
              onClick={() => remove(directory)}
            >
              <Trash2 size={14} aria-hidden="true" />{confirming && '确认移除？'}
            </button>
            <button
              type="button"
              role="switch"
              className="cdir-switch"
              aria-checked={enabled}
              aria-label={`允许当前员工检索 ${directory.display_name}`}
              disabled={busy || (!ready && !enabled)}
              onClick={() => void toggle(directory)}
            />
          </li>
        })}
      </ul>}

    {feedback && <p className="cdir-notice ok" role="status"><CircleCheck size={15} aria-hidden="true" /><span>{feedback}</span></p>}
    {error && <p className="cdir-notice err" role="alert"><CircleAlert size={15} aria-hidden="true" /><span>{error}</span></p>}
    {generating && <p className="cperm-hint">回复生成中，目录开关的改动从下一条消息生效。</p>}

    <div className="cdir-footer">
      <button type="button" className="cdir-add" disabled={busy} onClick={() => void addDirectory()}>
        {busy ? <LoaderCircle size={14} className="cdir-spinner" aria-hidden="true" /> : <FolderPlus size={14} aria-hidden="true" />}
        添加目录
      </button>
      <span className="cperm-hint">只检索纯文本资料（txt、md、csv、json、log），内容不上传；命中的片段和文件名会随消息发给模型。</span>
    </div>
  </section>
}
