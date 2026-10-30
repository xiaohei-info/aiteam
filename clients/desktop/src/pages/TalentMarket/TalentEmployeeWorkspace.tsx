import { useEffect, useRef, useState } from 'react'
import { BookOpen, LoaderCircle, RefreshCw } from 'lucide-react'
import type { ExpertProjection } from '../../api/agent/types'
import { recordApplicationLog } from '../../lib/applicationLog'
import { fetchKnowledgeBases, updateEmployeeKnowledgeBases } from '../KnowledgeBase/api'
import { knowledgeBaseSourceLabel } from '../KnowledgeBase/knowledgeService'
import type { KnowledgeBase } from '../KnowledgeBase/types'
import { loadTalentEmployees } from './talentEmployeeChat'
import styles from './TalentDetailPanel.module.css'

/**
 * 已招募人才对应的企业员工：Manager 规定同一模板每个企业只能招募一次，正常只有一个员工，
 * 不再让用户选择实例。对话入口在详情底部；这里只负责缺失提示和关联知识库。
 */
export default function TalentEmployeeWorkspace({ templateId, showKnowledge }: { templateId: string; showKnowledge: boolean }) {
  const [employee, setEmployee] = useState<ExpertProjection | null>(null)
  const [bases, setBases] = useState<KnowledgeBase[]>([])
  const [loading, setLoading] = useState(true)
  const [knowledgeLoading, setKnowledgeLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const activeRef = useRef(true)
  const [attempt, setAttempt] = useState(0)
  const [knowledgeAttempt, setKnowledgeAttempt] = useState(0)
  const [error, setError] = useState('')
  const [knowledgeError, setKnowledgeError] = useState('')
  const [feedback, setFeedback] = useState('')
  const employeeId = employee?.employee_id ?? ''

  useEffect(() => { activeRef.current = true; return () => { activeRef.current = false } }, [])
  useEffect(() => {
    let active = true
    setLoading(true); setError(''); setEmployee(null)
    async function load() {
      const matches = await loadTalentEmployees(templateId)
      if (!active) return
      if (matches.length > 1) recordApplicationLog('warn', 'talent.employees.multiple', { count: matches.length })
      setEmployee(matches[0] ?? null)
    }
    void load().catch(err => { if (active) setError(err instanceof Error ? err.message : '员工读取失败') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [templateId, attempt])

  useEffect(() => {
    if (!showKnowledge) return
    let active = true
    setKnowledgeLoading(true); setKnowledgeError('')
    fetchKnowledgeBases(messages => { if (active) setKnowledgeError(messages.join('；')) }).then(items => {
      if (active) setBases(items)
    }).catch(err => { if (active) setKnowledgeError(err instanceof Error ? err.message : '知识库读取失败') })
      .finally(() => { if (active) setKnowledgeLoading(false) })
    return () => { active = false }
  }, [showKnowledge, knowledgeAttempt])

  async function bind(base: KnowledgeBase) {
    if (!employee || busyRef.current) return
    busyRef.current = true; setBusy(true); setFeedback(''); setKnowledgeError('')
    try {
      await updateEmployeeKnowledgeBases(employee.employee_id, [base.id])
      if (!activeRef.current) return
      setBases(current => current.map(item => item.id === base.id ? { ...item, employeeBindings: [...(item.employeeBindings ?? []), { employeeId: employee.employee_id, displayName: employee.display_name }] } : item))
      setFeedback(`已将「${base.name}」关联到「${employee.display_name}」。${base.source === 'local' ? 'NAS 检索还需员工具备对应工具。' : '企业配置需待本机授权更新后生效。'}`)
    } catch (err) { if (activeRef.current) setKnowledgeError(err instanceof Error ? err.message : '关联失败') }
    finally { busyRef.current = false; if (activeRef.current) setBusy(false) }
  }

  const missing = !loading && !employee && !error
  if (!showKnowledge && !missing && !error) return null

  return <section className={styles.employeeWorkspace} aria-label="人才对应员工">
    {loading && showKnowledge && <p role="status"><LoaderCircle size={14} /> 正在读取招募与授权…</p>}
    {missing && <div className={styles.sectionHeader}>
      <p className={styles.workspaceHint}>已招募，但本机还没有该员工的授权。请在企业后台完成员工配置和成员授权后刷新。</p>
      <button className={styles.workspaceIconButton} type="button" aria-label="刷新员工授权" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15} /></button>
    </div>}
    {error && <p role="alert" className={styles.workspaceError}>{error}</p>}
    {showKnowledge && employee && <div className={styles.workspaceKnowledge}>
      <div className={styles.sectionHeader}><h3><BookOpen size={15} /> 关联知识库</h3><button type="button" className={styles.workspaceIconButton} aria-label="刷新可关联知识库" disabled={busy || knowledgeLoading} onClick={() => setKnowledgeAttempt(value => value + 1)}><RefreshCw size={15} /></button></div>
      <p>关联作用于员工「{employee.display_name}」，不会修改人才市场模板。Manager 写入需要其令牌具有企业管理权限。</p>
      {knowledgeLoading ? <p role="status">正在加载知识库…</p> : !bases.length ? <p>暂无知识库，请先在知识库页面连接企业知识库，或添加 NAS 后在它那一行新建知识库。</p> : bases.map(base => {
        const linked = base.employeeBindings?.some(binding => binding.employeeId === employeeId)
        return <div className={styles.workspaceKnowledgeRow} key={base.id}><div><strong>{base.name}</strong><small>{knowledgeBaseSourceLabel(base)} · {base.docCount} 个文档</small></div><button type="button" className={styles.secondaryBtn} disabled={busy || linked} onClick={() => void bind(base)}>{linked ? '已关联' : '关联'}</button></div>
      })}
      {knowledgeError && <p role="alert" className={styles.workspaceError}>{knowledgeError}</p>}
    </div>}
    {feedback && <p role="status">{feedback}</p>}
  </section>
}
