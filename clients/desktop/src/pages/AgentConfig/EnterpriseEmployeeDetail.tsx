import { useEffect, useState } from 'react'
import { ArrowLeft, Camera, ChevronRight, X } from 'lucide-react'
import { backendApi } from '../../api/backend'
import { getAvatarFallback, getEmployeeAvatar, renderAvatar } from '../../lib/avatarUtils'
import type { ExpertProjection, OrgTreeNode } from '../../api/agent/types'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import { skillDisplayNames } from '../../lib/skillDisplay'
import './EnterpriseEmployeeDetail.css'

interface EnterpriseEmployeeDetailProps { employeeId: string; onBack: () => void }
const fallback = (v: unknown, d = '暂无') => typeof v === 'string' && v.trim() ? v : d
const departments = (n: OrgTreeNode, out: Record<string, string> = {}) => { if (n.type === 'department') out[n.id] = n.name; n.children?.forEach(c => departments(c, out)); return out }

export default function EnterpriseEmployeeDetail({ employeeId, onBack }: EnterpriseEmployeeDetailProps) {
  const [employee, setEmployee] = useState<ExpertProjection | null>(null); const [dept, setDept] = useState<Record<string, string>>({}); const [error, setError] = useState(''); const [avatar, setAvatar] = useState<string | null>(null); const [avatarViewer, setAvatarViewer] = useState(false)
  useGlobalShortcutClose({ onClose: onBack, layer: 'panel' })
  useEffect(() => { let dead = false; Promise.all([backendApi.listExperts(), backendApi.getOrgTree().catch(() => null)]).then(([list, tree]) => { if (dead) return; const found = list.experts.find(e => e.employee_id === employeeId && !e.revoked); if (!found) return setError('该员工当前不可见'); setEmployee(found); if (tree) setDept(departments(tree)) }).catch(e => !dead && setError(e instanceof Error ? e.message : '员工读取失败')); return () => { dead = true } }, [employeeId])
  const upload = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (!f?.type.startsWith('image/')) return; const r = new FileReader(); r.onload = () => setAvatar(String(r.result)); r.readAsDataURL(f) }
  const open = (target: string) => window.dispatchEvent(new CustomEvent('app:navigate', { detail: target }))
  if (!employee && !error) return <div className="eed-loading">正在读取员工…</div>
  const department = employee?.department_ids?.map(id => dept[id]).filter(Boolean).join('、') || '未分配部门'
  const employeeAvatar = employee ? getEmployeeAvatar(employee.display_name, avatar || employee.avatar_url) : ''
  const employeeAvatarFallback = employee ? getAvatarFallback(employee.display_name) : '?'
  const skills = skillDisplayNames(employee?.skills, employee?.skill_details)

  return <div className="eed"><header><button type="button" className="eed-back" onClick={onBack}><ArrowLeft size={16} />返回员工列表</button><span>员工详情</span></header>{error && <p className="eed-error">{error}</p>}{employee && <><section className="eed-hero"><button type="button" aria-label="查看头像大图" className="eed-avatar" onClick={() => setAvatarViewer(true)}>{renderAvatar(employeeAvatar, employeeAvatarFallback)}<i><Camera size={15} /></i></button><div><h1>{employee.display_name}</h1><small>{department}</small></div></section><main className="eed-grid"><Card title="岗位描述" kind="wide"><p>{fallback(employee.persona || employee.description || employee.role_description, '暂无岗位描述')}</p></Card><Card title="擅长技能"><div className="eed-tags">{skills.length ? skills.slice(0, 5).map(skill => <span key={skill}>{skill}</span>) : <em>暂无技能说明</em>}</div><p className="eed-summary">{skills.length ? `可以帮助你完成${skills.slice(0, 3).join('、')}等工作。` : ''}</p></Card><Card title="记忆摘要" action="查看详情" onClick={() => open(`/memory?employee=${employeeId}`)} kind="accent"><p>{fallback(employee.memory_summary || employee.memory_policy?.summary, '最近 3 天暂无新的记忆摘要')}</p><small className="eed-range">最近 3 天</small></Card><Card title="模型"><p className="eed-value">{fallback(employee.model_policy?.model || employee.model_policy?.provider_ref)}</p></Card><Card title="可操作系统"><div className="eed-tags">{employee.connector_refs?.length ? employee.connector_refs.map(item => <span key={item}>{item}</span>) : <em>暂无已配置的 MCP 系统</em>}</div></Card><Card title="关联的知识库" action="查看详情" onClick={() => open(`/knowledge?employee=${employeeId}`)}><p>{employee.knowledge_refs?.join('、') || '暂无关联知识库'}</p></Card><Card title="自动化任务" action="查看详情" onClick={() => open(`/auto-tasks?employee=${employeeId}`)}><p>{Array.isArray(employee.automation_tasks) && employee.automation_tasks.length ? employee.automation_tasks.join('、') : '暂无关联自动化任务'}</p></Card></main></>}{avatarViewer && employee && <div className="eed-avatar-modal" role="dialog" aria-modal="true" aria-label={`${employee.display_name}头像预览`} onClick={() => setAvatarViewer(false)}><div className="eed-avatar-preview" onClick={event => event.stopPropagation()}><div className="eed-avatar-preview-header"><span>头像预览</span><button type="button" className="eed-avatar-close" onClick={() => setAvatarViewer(false)} aria-label="关闭预览"><X size={16} /></button></div><div className="eed-avatar-large">{renderAvatar(employeeAvatar, employeeAvatarFallback)}</div><label className="eed-avatar-upload">{<><Camera size={15} />切换头像</>}<input hidden type="file" accept="image/*" onChange={upload} /></label></div></div>}</div>
}
function Card({ title, action, onClick, children, kind = '', }: { title: string; action?: string; onClick?: () => void; children: React.ReactNode; kind?: string }) { return <section className={`eed-card ${kind}`}><div><strong>{title}</strong>{action && <button onClick={onClick}>{action}<ChevronRight size={14} /></button>}</div>{children}</section> }
