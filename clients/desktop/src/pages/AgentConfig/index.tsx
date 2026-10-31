import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './index.module.css'
import { backendApi } from '../../api/backend'
import type { ExpertProjection } from '../../api/agent/types'
import { useEnterpriseWrite } from '../../hooks/useEnterpriseWrite'
import EnterpriseEmployeeDetail from './EnterpriseEmployeeDetail'

export default function AgentConfig() {
  const navigate = useNavigate()
  const permission = useEnterpriseWrite()
  const [employees, setEmployees] = useState<ExpertProjection[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(''); setEmployees([])
    backendApi.listExperts()
      .then(result => { if (!cancelled) setEmployees(result.experts.filter(employee => !employee.revoked)) })
      .catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : '企业员工读取失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [attempt])
  if (selectedId) return <EnterpriseEmployeeDetail employeeId={selectedId} onBack={() => { setSelectedId(null); setAttempt(value => value + 1) }} />
  return <div className={styles.root}>
    <div className={styles.toolbar}><p className={styles.subtitle}>当前成员可见员工</p><button type="button" onClick={() => navigate('/talents')} className={styles.createBtn}>查看人才市场</button></div>
    <div className="flex gap-3 mb-4"><button type="button" onClick={() => setAttempt(value => value + 1)} disabled={loading}>刷新</button>{!permission.enabled && <p>{permission.reason}</p>}</div>
    {loading && <p role="status">正在读取企业员工…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && !employees.length && <p>当前没有可见员工</p>}
    <div className={styles.agentGrid}>{employees.map(employee => <button type="button" key={employee.employee_id} className="p-4 rounded-lg border border-[var(--border)] bg-surface-1 text-left" onClick={() => setSelectedId(employee.employee_id)}>
      <h3>{employee.display_name || employee.employee_id}</h3><p className="text-txt-secondary text-sm">{employee.role_title ?? '岗位未设置'}</p><p className="text-txt-muted text-xs">生命周期：{employee.status}</p>
    </button>)}</div>
  </div>
}
