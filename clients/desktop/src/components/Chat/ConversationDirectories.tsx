import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CircleAlert, CircleCheck, FolderOpen, FolderPlus, LoaderCircle, X } from 'lucide-react'
import './ChatTools.css'
import './ConversationDirectories.css'
import { agentApi, AgentApiError, isRevisionConflict } from '../../api/agent'
import type { LocalDirectory } from '../../api/agent'
import { invokeErrorText, localDirectoryApiErrorText, statusLabel } from './localDirectoryErrors'
import { isDraftConversation } from '../../lib/conversationPermissions'

/**
 * 本会话添加的目录：和工作目录一样按本会话的权限读写，员工也能用检索工具查其中的资料。
 * 每个会话只看到自己添加的目录，群聊里所有员工共用；移除只关掉本会话的绑定，不影响其他会话，也不删除文件夹。
 * 目录授权、绑定都只走本机 Agent，不依赖企业 Manager / NAS 连接。
 * 状态放在权限按钮所在的组件里，面板收起时按钮仍能汇总添加的目录数。
 *
 * conversationId 以 `emp_` 开头时是还没创建的草稿会话：没有目录，添加前先 ensureConversation 建会话。
 */
export function useConversationDirectories(conversationId: string, ensureConversation: () => Promise<{ id: string }>) {
  const [supported, setSupported] = useState(false)
  const [directories, setDirectories] = useState<LocalDirectory[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const activeRef = useRef(true)
  const busyRef = useRef(false)
  const savedId = isDraftConversation(conversationId) ? undefined : conversationId
  // 切换会话后丢弃上一个会话迟到的列表结果。
  const savedIdRef = useRef(savedId)
  savedIdRef.current = savedId

  useEffect(() => {
    activeRef.current = true
    return () => { activeRef.current = false }
  }, [])

  const load = useCallback(async (id = savedIdRef.current) => {
    // 草稿会话还没有添加任何目录。
    if (!id) { setDirectories([]); return }
    setLoading(true); setError('')
    try {
      const payload = await agentApi.listLocalDirectories(id)
      if (activeRef.current && savedIdRef.current === id) setDirectories(payload.directories)
    } catch (err) {
      if (activeRef.current && savedIdRef.current === id) setError(localDirectoryApiErrorText(err))
    } finally {
      if (activeRef.current) setLoading(false)
    }
  }, [])

  // 旧版内嵌 Agent 没有本地目录接口时隐藏目录列表。
  useEffect(() => {
    let active = true
    agentApi.supportsLocalDirectories().then(ok => {
      if (!active) return
      setSupported(ok)
    }).catch(() => { if (active) setSupported(false) })
    return () => { active = false }
  }, [])
  // 每个会话的目录各不相同：换会话（含草稿建成正式会话）时重新读取。
  useEffect(() => {
    if (!supported) return
    setDirectories([]); setFeedback('')
    void load(savedId)
  }, [supported, savedId, load])

  // 列表里也有本会话移除过的目录（enabled=false，留着 revision 供重新添加），只展示开着的。
  const added = directories.filter(directory => directory.binding?.enabled)

  async function run(task: () => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(''); setFeedback('')
    try {
      await task()
    } catch (err) {
      if (!activeRef.current) return
      if (err instanceof AgentApiError && isRevisionConflict(err)) {
        await load()
        setError('目录刚被其他窗口修改，列表已刷新，请重试。')
      } else if (err instanceof AgentApiError) setError(localDirectoryApiErrorText(err))
      else setError(invokeErrorText(err))
    } finally {
      busyRef.current = false
      if (activeRef.current) setBusy(false)
    }
  }

  const addDirectory = () => run(async () => {
    const challenge = await agentApi.createLocalDirectoryChallenge()
    const selection = await invoke<{ ticket: string }>('select_local_knowledge_directory', { challenge })
    const registered = await agentApi.registerLocalDirectory(selection.ticket)
    // 只加到本会话；其他会话看不到。
    const { id } = await ensureConversation()
    const current = directories.find(directory => directory.directory_id === registered.directory_id)
    const binding = current?.binding
    if (!binding?.enabled) await agentApi.setLocalDirectoryBinding(id, registered.directory_id, true, binding?.revision ?? 0)
    if (!activeRef.current) return
    setFeedback(`已添加「${registered.display_name}」。员工可以在本会话里按上面的权限读写它，也能检索其中的资料。`)
    await load(id)
  })

  const remove = (directory: LocalDirectory) => run(async () => {
    const binding = directory.binding
    if (!binding?.enabled) return
    const { id } = await ensureConversation()
    await agentApi.setLocalDirectoryBinding(id, directory.directory_id, false, binding.revision)
    if (!activeRef.current) return
    setFeedback(`已从本会话移除「${directory.display_name}」。文件夹本身不会被删除，其他会话不受影响。`)
    await load(id)
  })

  /** 面板展开时清掉上一次的反馈并刷新列表。 */
  const refresh = () => { setFeedback(''); if (supported) void load() }

  return { supported, added, loading, busy, error, feedback, enabledCount: added.length, addDirectory, remove, refresh }
}

export type ConversationDirectoriesController = ReturnType<typeof useConversationDirectories>

interface ConversationDirectoriesProps {
  controller: ConversationDirectoriesController
  generating: boolean
}

/** 权限面板「本会话的目录」区里，工作目录下面的「添加的目录」列表。 */
export function ConversationDirectories({ controller, generating }: ConversationDirectoriesProps) {
  const { supported, added, loading, busy, error, feedback, addDirectory, remove } = controller
  if (!supported) return null

  return <div className="cdir-added">
    {loading && !added.length ? <p className="cdir-loading" role="status"><LoaderCircle size={14} className="cdir-spinner" aria-hidden="true" />正在读取目录…</p>
      : added.length > 0 && <ul className="cdir-list" aria-label="本会话添加的目录">
        {added.map(directory => {
          const ready = directory.status === 'ready'
          return <li key={directory.directory_id} className={`cdir-item enabled${ready ? '' : ' unavailable'}`}>
            <span className="cdir-icon"><FolderOpen size={16} aria-hidden="true" /></span>
            <div className="cdir-meta">
              <div className="cdir-name">
                <strong title={directory.display_name}>{directory.display_name}</strong>
                {!ready && <span className="cdir-badge bad">{statusLabel(directory.status)}</span>}
              </div>
              <code title={directory.path}>{directory.path}</code>
            </div>
            <button
              type="button"
              className="cdir-remove"
              disabled={busy}
              title="从本会话移除（不删除文件夹，不影响其他会话）"
              aria-label={`从本会话移除 ${directory.display_name}`}
              onClick={() => void remove(directory)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </li>
        })}
      </ul>}

    {feedback && <p className="cdir-notice ok" role="status"><CircleCheck size={15} aria-hidden="true" /><span>{feedback}</span></p>}
    {error && <p className="cdir-notice err" role="alert"><CircleAlert size={15} aria-hidden="true" /><span>{error}</span></p>}
    {generating && <p className="cperm-hint">下条消息起生效</p>}

    <div className="cdir-footer">
      <button type="button" className="cdir-add" disabled={busy} onClick={() => void addDirectory()}>
        {busy ? <LoaderCircle size={14} className="cdir-spinner" aria-hidden="true" /> : <FolderPlus size={14} aria-hidden="true" />}
        添加目录
      </button>
    </div>
  </div>
}
