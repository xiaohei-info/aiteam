/** 交给员工继续做：选一位员工，在项目目录中开启新对话。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import { RefreshCw, UserRoundPlus } from 'lucide-react'
import { agentApi } from '../../api/agent'
import type { ExpertProjection } from '../../api/agent/types'
import { ChatDialog } from '../../components/Chat/ChatDialog'
import { getAvatarFallback, getEmployeeAvatar, renderAvatar } from '../../lib/avatarUtils'
import { employeeUnavailableMessage } from '../../lib/employeeAvailability'
import {
  createProjectConversation,
  describeProjectConversationError,
  MAX_CONVERSATION_TITLE,
  projectConversationTitle,
} from '../../lib/projectConversation'
import { useChatStore } from '../../stores/chat'
import type { ProjectSummary } from './projects'
import styles from './index.module.css'

const SEARCH_THRESHOLD = 6

export default function ProjectDevelopDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const navigate = useNavigate()
  const [experts, setExperts] = useState<ExpertProjection[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [employeeId, setEmployeeId] = useState('')
  const [title, setTitle] = useState(project.name.slice(0, MAX_CONVERSATION_TITLE))
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadFailed(false)
    try {
      const { experts: list } = await agentApi.listExperts()
      if (alive.current) setExperts(list.filter(expert => !expert.revoked))
    } catch {
      if (alive.current) setLoadFailed(true)
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return experts
    return experts.filter(expert => `${expert.display_name} ${expert.role_title ?? ''}`.toLowerCase().includes(needle))
  }, [experts, query])

  const start = async () => {
    const employee = experts.find(expert => expert.employee_id === employeeId)
    if (!employee || busy.current) return
    busy.current = true
    setCreating(true)
    setError('')
    try {
      const created = await createProjectConversation({
        createChallenge: () => agentApi.createLocalDirectoryChallenge(),
        authorize: (challenge, source, projectId) => invoke<{ ticket: string }>('authorize_project_workspace', { challenge, source, projectId }),
        create: params => agentApi.createConversation(params),
      }, { project, employeeId, title })
      const store = useChatStore.getState()
      store.addConversation({
        id: created.id,
        title: created.title?.trim() || projectConversationTitle(title, project.name),
        agentEmoji: '🤖',
        agentAvatarUrl: employee.avatar_url ?? null,
        agentName: employee.display_name,
        lastMessage: '',
        time: '',
        projectName: created.project?.name ?? project.name,
        _employeeId: employeeId,
      })
      navigate('/chat', {
        state: {
          employeeId,
          conversationId: created.id,
          profileName: employee.display_name,
          agentName: employee.display_name,
          refreshWorkbench: true,
        },
      })
    } catch (failure) {
      console.error('[Workbench] create project conversation failed:', failure)
      busy.current = false
      if (alive.current) {
        setError(describeProjectConversationError(failure))
        setCreating(false)
      }
    }
  }

  return <ChatDialog
    title="交给员工继续做"
    icon={<UserRoundPlus size={18} />}
    description={project.name}
    onClose={() => { if (!busy.current) onClose() }}
  >
    <p className="chat-tools-note">员工会直接在这个项目的目录里接着做，可以修改其中的文件。这是一个新对话，有自己的上下文和记忆，不影响这位员工的其他对话。几个对话可以同时做同一个项目，请留意彼此的改动。</p>
    {project.location && <p className={styles.consentCwd}><span>项目目录</span>{project.location}</p>}

    <label className={styles.developField}>
      <span>对话名称</span>
      <input
        className="chat-tools-search"
        value={title}
        maxLength={MAX_CONVERSATION_TITLE}
        placeholder={project.name}
        disabled={creating}
        onChange={event => setTitle(event.target.value)}
      />
    </label>

    <div className={styles.developField}>
      <span id="project-develop-employee">选择员工</span>
      {experts.length > SEARCH_THRESHOLD && <input
        className="chat-tools-search"
        value={query}
        placeholder="搜索员工"
        aria-label="搜索员工"
        onChange={event => setQuery(event.target.value)}
      />}
      {loading && <p className={styles.hint}>正在读取员工…</p>}
      {!loading && loadFailed && <p className={styles.hint}>员工读取失败。<button type="button" onClick={() => void load()}><RefreshCw size={12} />重试</button></p>}
      {!loading && !loadFailed && visible.length === 0 && <p className={styles.hint}>{experts.length === 0 ? '暂无可用员工。' : '没有匹配的员工。'}</p>}
      {!loading && !loadFailed && visible.length > 0 && <div className={styles.developEmployees} role="radiogroup" aria-labelledby="project-develop-employee">
        {visible.map(expert => {
          const unavailable = employeeUnavailableMessage(expert)
          return <label key={expert.employee_id} className={styles.developEmployee} data-disabled={unavailable ? 'true' : undefined}>
            <input
              type="radio"
              name="project-develop-employee"
              value={expert.employee_id}
              checked={employeeId === expert.employee_id}
              disabled={Boolean(unavailable) || creating}
              onChange={() => setEmployeeId(expert.employee_id)}
            />
            <span className={styles.developAvatar}>{renderAvatar(getEmployeeAvatar(expert.display_name, expert.avatar_url), getAvatarFallback(expert.display_name))}</span>
            <span className={styles.developEmployeeText}>
              <strong>{expert.display_name}</strong>
              <small>{unavailable ?? expert.role_title ?? '岗位未设置'}</small>
            </span>
          </label>
        })}
      </div>}
    </div>

    {error && <p className={styles.developError} role="alert">{error}</p>}
    <footer>
      <button type="button" disabled={creating} onClick={onClose}>取消</button>
      <button type="button" disabled={!employeeId || creating} onClick={() => void start()}>{creating ? '正在开启…' : '开始对话'}</button>
    </footer>
  </ChatDialog>
}
