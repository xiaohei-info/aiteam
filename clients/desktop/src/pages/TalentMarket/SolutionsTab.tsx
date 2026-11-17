import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { LoaderCircle, MessageCircle, ShieldAlert, User, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { agentApi } from '../../api/agent'
import type { ExpertProjection, SolutionProjection } from '../../api/agent/types'
import GoldenDotsLoading from '../../components/Loading/GoldenDotsLoading'
import RequestErrorState from '../../components/RequestState/RequestErrorState'
import { classifyRequestError, type RequestErrorInfo } from '../../lib/requestError'
import { useChatStore } from '../../stores/chat'
import { startTalentEmployeeChat } from './talentEmployeeChat'
import {
  recommendedSummary,
  solutionMembers,
  solutionMode,
  solutionStart,
  SOLUTION_MODE_LABEL,
} from './solutionMarket'

/** 本机已授权的行业方案。不新增 Agent→Manager 目录接口：只展示 Manager 已授权并同步到本机的方案。 */
export default function SolutionsTab({ query }: { query: string }) {
  const navigate = useNavigate()
  const [solutions, setSolutions] = useState<SolutionProjection[]>([])
  const [experts, setExperts] = useState<ExpertProjection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<RequestErrorInfo | null>(null)
  const [actionError, setActionError] = useState('')
  const [startingId, setStartingId] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [solutionRes, expertRes] = await Promise.all([agentApi.listSolutions(), agentApi.listExperts()])
      if (!alive.current) return
      setSolutions(solutionRes.solutions.filter(item => item.status === undefined || item.status === 'applied'))
      setExperts(expertRes.experts)
    } catch (err) {
      console.error(err)
      if (alive.current) setError(classifyRequestError(err, '方案加载失败，请稍后重试。'))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const start = useCallback(async (solution: SolutionProjection) => {
    if (startingId) return
    const action = solutionStart(solution, experts)
    if (action.kind === 'unavailable') return
    setStartingId(solution.solution_instance_id)
    setActionError('')
    try {
      if (action.kind === 'chat') {
        const employee = experts.find(item => item.employee_id === action.employeeId)
        if (!employee) throw new Error('方案成员尚未授权到本机')
        await startTalentEmployeeChat(employee, navigate, () => alive.current)
        return
      }
      const conversation = await agentApi.createConversation({
        kind: 'group',
        solution_instance_id: solution.solution_instance_id,
        coordinator_employee_id: solution.coordinator_employee_id ?? solution.expert_employee_ids?.[0] ?? null,
        title: solution.display_name,
      })
      await useChatStore.getState().refreshConversations()
      useChatStore.getState().setActiveGroupId(conversation.id)
      navigate('/group-chat')
    } catch (err) {
      console.error(err)
      if (alive.current) setActionError(err instanceof Error ? err.message : '发起失败，请稍后重试')
    } finally {
      if (alive.current) setStartingId(null)
    }
  }, [experts, navigate, startingId])

  if (error) return <RequestErrorState error={error} onRetry={() => void load()} retrying={loading} />
  if (loading) return <div className="tm-loading"><GoldenDotsLoading label="加载方案中" /></div>

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? solutions.filter(item => `${item.display_name} ${item.description ?? ''} ${(item.tags ?? []).join(' ')}`.toLowerCase().includes(needle))
    : solutions

  if (!visible.length) {
    return (
      <div className="tm-empty">
        <h2>{solutions.length ? '没有找到匹配方案' : '当前没有可用的行业方案'}</h2>
        <p>{solutions.length ? '换个关键词再试一次。' : '方案需要企业管理员应用并授权给你后才会出现在这里，授权后点击刷新。'}</p>
      </div>
    )
  }

  return (
    <section className="tm-section" aria-label="行业方案">
      {actionError && <div className="tm-error" role="alert"><span>{actionError}</span></div>}
      <div className="tm-agent-grid">
        {visible.map((solution, index) => {
          const mode = solutionMode(solution)
          const action = solutionStart(solution, experts)
          const members = solutionMembers(solution, experts)
          const recommended = recommendedSummary(solution)
          const shown = members.slice(0, 3)
          const hidden = members.length - shown.length
          const busy = startingId === solution.solution_instance_id
          const Icon = mode === 'solo' ? MessageCircle : Users
          return (
            <article
              key={solution.solution_instance_id}
              className="tm-agent-row"
              style={{ '--tm-index': index } as CSSProperties}
            >
              <div className="tm-agent-summary static">
                <span className="tm-agent-head">
                  <span className="tm-agent-avatar" aria-hidden="true">
                    {mode === 'solo' ? <User size={26} strokeWidth={1.6} /> : <Users size={26} strokeWidth={1.6} />}
                  </span>
                  <span className="tm-agent-title-stack">
                    <span className="tm-agent-name-row"><span className="tm-agent-name">{solution.display_name}</span></span>
                    <span className="tm-agent-role">{SOLUTION_MODE_LABEL[mode]}方案</span>
                  </span>
                </span>
                <span className="tm-agent-body">
                  <span className="tm-agent-desc">{solution.description || '暂无方案说明'}</span>
                  <span className="tm-agent-meta-row">
                    <span className="tm-agent-meta">
                      {shown.map(member => <span key={member.employee_id}>{member.display_name}</span>)}
                      {hidden > 0 && <span>+{hidden}</span>}
                    </span>
                  </span>
                </span>
                <span className="tm-agent-stats" aria-label="方案数据">
                  <span className="tm-agent-stat"><span>成员</span><strong>{solution.expert_employee_ids?.length ?? 0} 位</strong></span>
                  <span className="tm-agent-stat"><span>协作方式</span><strong>{mode === 'solo' ? '私聊' : '群聊'}</strong></span>
                  <span className="tm-agent-stat" title={recommended ? `${recommended}（仅提示，使用中需要时会先询问你是否安装）` : undefined}>
                    <span>推荐能力</span><strong>{recommended ? `${solution.recommended_capabilities?.length ?? 0} 项` : '无'}</strong>
                  </span>
                </span>
              </div>
              <span className="tm-agent-actions">
                {action.kind === 'unavailable' ? (
                  <>
                    <button className="tm-agent-recruit" type="button" disabled><ShieldAlert size={14} strokeWidth={2} />暂不可用</button>
                    <span className="tm-agent-blocked-reason" role="status" title={action.reason}>{action.reason}</span>
                  </>
                ) : (
                  <button className="tm-agent-recruit" type="button" disabled={Boolean(startingId)} onClick={() => void start(solution)}>
                    {busy ? <LoaderCircle size={14} strokeWidth={2} className="spinning" /> : <Icon size={14} strokeWidth={2} />}
                    {busy ? '处理中…' : action.label}
                  </button>
                )}
              </span>
            </article>
          )
        })}
      </div>
    </section>
  )
}
