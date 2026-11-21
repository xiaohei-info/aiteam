/**
 * 「能力」页的「添加技能」窗口：列出企业开放给本人的技能，本人点「安装」直接装到本机（不经对话与模型）。
 * 与对话中审批安装相同：只能装企业技能目录里的、签名校验通过的技能；已装其他版本时要本人确认才换。
 */
import { useEffect, useMemo, useState } from 'react'
import { BookOpen, LoaderCircle, Search } from 'lucide-react'
import { ChatDialog } from '../../components/Chat/ChatDialog'
import { agentApi, AgentApiError } from '../../api/agent'
import type { InstallableSkill, LocalCapability } from '../../api/agent/types'
import { installableSkillState } from './capabilityLabels'
import { CustomSkillImport } from './CustomSkillImport'
import './McpAuth.css'

type SkillSourceTab = 'catalog' | 'custom'

function listError(error: unknown): string {
  if (error instanceof AgentApiError && error.status === 503) return '暂时无法连接企业服务，请稍后再试。'
  return error instanceof Error && error.message ? error.message : '企业技能目录读取失败'
}

export function AddSkillDialog({ installed, onInstalled, onClose }: { installed: LocalCapability[]; onInstalled: () => Promise<void> | void; onClose: () => void }) {
  const [tab, setTab] = useState<SkillSourceTab>('catalog')
  const [skills, setSkills] = useState<InstallableSkill[] | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    agentApi.listInstallableSkills().then((rows) => { if (alive) setSkills(rows) }, (err) => { if (alive) setError(listError(err)) })
    return () => { alive = false }
  }, [])

  const shown = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return (skills ?? []).filter((skill) => !keyword || `${skill.display_name} ${skill.skill_id}`.toLowerCase().includes(keyword))
  }, [skills, query])

  const install = async (skill: InstallableSkill, replace: boolean) => {
    setBusy(skill.skill_id)
    setRowError(null)
    try {
      await agentApi.installSkill(skill.skill_id, replace)
      await onInstalled()
    } catch (err) {
      setRowError({ id: skill.skill_id, text: err instanceof Error && err.message ? err.message : '安装失败，请重试' })
    } finally { setBusy(null) }
  }

  return <ChatDialog title="添加技能" description="从企业拿，或导入你自己的技能；只装在本机、只对你自己的会话生效" icon={<BookOpen size={18} />} className="mcp-dialog" onClose={onClose}>
    <div className="mcp-form">
      <div className="skill-source-tabs" role="tablist" aria-label="技能来源">
        <button type="button" role="tab" aria-selected={tab === 'catalog'} className={tab === 'catalog' ? 'on' : ''} onClick={() => setTab('catalog')}>从企业拿</button>
        <button type="button" role="tab" aria-selected={tab === 'custom'} className={tab === 'custom' ? 'on' : ''} onClick={() => setTab('custom')}>自定义</button>
      </div>
      {tab === 'custom'
        ? <CustomSkillImport onInstalled={onInstalled} onClose={onClose} />
        : <>
      {error ? <p role="alert" className="mcp-error">{error}</p>
        : skills === null ? <p className="mcp-note" role="status"><LoaderCircle className="file-access-spinner" size={13} aria-hidden="true" /> 正在读取企业技能目录…</p>
          : skills.length === 0 ? <p className="mcp-note">企业还没有开放可自行安装的技能。需要某个技能时，请联系企业管理员安装到企业技能目录并设为全员可见。</p>
            : <>
              {skills.length > 6 && <label className="skill-search">
                <Search size={14} aria-hidden="true" />
                <input aria-label="搜索技能" placeholder="搜索技能名称或标识" value={query} onChange={(event) => setQuery(event.target.value)} />
              </label>}
              <ul className="skill-list" aria-label="企业可安装的技能">
                {shown.map((skill) => {
                  const state = installableSkillState(skill, installed)
                  const working = busy === skill.skill_id
                  return <li key={skill.skill_id}>
                    <span className="skill-list-copy">
                      <strong>{skill.display_name || skill.skill_id}</strong>
                      <span>{skill.origin === 'platform' ? '平台技能市场' : '企业自建'} · 版本 {skill.version} · 标识 {skill.skill_id}</span>
                      {state.action === 'upgrade' && <span>本机已装 {state.from || '其他'} 版，安装后换成 {skill.version} 版。</span>}
                      {rowError?.id === skill.skill_id && <span role="alert" className="mcp-error">{rowError.text}</span>}
                    </span>
                    {state.action === 'installed'
                      ? <span className="mcp-auth-badge">已安装</span>
                      : <button type="button" disabled={busy !== null} onClick={() => void install(skill, state.action === 'upgrade')}>
                        {working ? '正在安装…' : state.action === 'upgrade' ? `换成 ${skill.version} 版` : '安装'}
                      </button>}
                  </li>
                })}
                {shown.length === 0 && <li><span className="mcp-note">没有匹配的技能。</span></li>}
              </ul>
            </>}
      <p className="mcp-note">技能可能附带脚本和资料，不会自动执行；员工运行命令仍按审批策略。安装后下一轮对话起可用。</p>
      <footer><button type="button" onClick={onClose}>关闭</button></footer>
        </>}
    </div>
  </ChatDialog>
}
