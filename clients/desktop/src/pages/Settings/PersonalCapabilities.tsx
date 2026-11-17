import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, BookOpen, LoaderCircle, Plug, ShieldCheck } from 'lucide-react'
import '../../components/FileAccess/FileAccess.css'
import { agentApi } from '../../api/agent'
import type { LocalCapability } from '../../api/agent/types'

/** 用户在对话中同意安装的个人能力：只在本机、只对本人会话生效，可随时撤销。 */
export default function PersonalCapabilities() {
  const [items, setItems] = useState<LocalCapability[] | null>(null)
  const [error, setError] = useState('')
  const [busyRef, setBusyRef] = useState<string | null>(null)
  const alive = useRef(true)
  // 挂载时置回 true：开发版 StrictMode 会先卸载再挂载一次，只在卸载时置 false 会让请求结果永远写不回页面。
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async () => {
    try {
      const rows = await agentApi.listLocalCapabilities()
      if (alive.current) { setItems(rows); setError('') }
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : '个人能力读取失败')
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const revoke = async (item: LocalCapability) => {
    setBusyRef(item.ref)
    setError('')
    try {
      await agentApi.deleteLocalCapability(item.kind, item.ref)
      await load()
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : '撤销失败')
    } finally {
      if (alive.current) setBusyRef(null)
    }
  }

  return <section id="personal-capabilities" className="settings-card glass-panel" aria-labelledby="settings-capabilities-title">
    <div className="settings-section-heading">
      <Plug size={16} strokeWidth={1.7} aria-hidden="true" />
      <div>
        <h2 id="settings-capabilities-title">个人能力（MCP 与技能）</h2>
        <p>你在对话中同意安装的 MCP 与技能，只保存在本机、只对你自己的会话生效。</p>
      </div>
      {items && <span className={`file-access-status ${items.length ? 'granted' : ''}`}>
        {items.length ? `已安装 ${items.length} 个` : '未安装'}
      </span>}
    </div>
    {error && <p role="alert" className="file-access-error"><AlertCircle size={14} aria-hidden="true" /><span>{error}</span></p>}
    {items === null && !error ? <p className="file-access-note" role="status"><LoaderCircle className="file-access-spinner" size={14} aria-hidden="true" />正在读取…</p>
      : items && items.length === 0 ? <div className="file-access-empty">
        <Plug size={20} strokeWidth={1.5} aria-hidden="true" />
        <div><strong>还没有安装个人能力</strong><p>对话中 Agent 需要某个 MCP 或企业技能时，会先询问你，同意后才会安装。</p></div>
      </div> : <ul className="file-access-grants" aria-label="已安装的个人能力">
        {(items ?? []).map(item => <li key={`${item.kind}:${item.ref}`}>
          <span className="file-access-directory-icon">{item.kind === 'skill'
            ? <BookOpen size={17} strokeWidth={1.7} aria-hidden="true" />
            : <Plug size={17} strokeWidth={1.7} aria-hidden="true" />}</span>
          <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 4 }}>
            <strong style={{ color: 'var(--text-primary)', fontSize: 13 }}>{item.display_name}</strong>
            {item.kind === 'skill' ? (
              <span style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.6 }}>
                技能 · 企业技能目录{item.version ? ` · 版本 ${item.version}` : ''}
              </span>
            ) : <span className="file-access-directory-path" title={item.url}>{item.url}</span>}
            <span style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.6 }}>
              {item.kind === 'skill' ? `标识：${item.ref}` : `工具：${item.tools.join('、') || '—'}`}{item.reason ? ` · 原因：${item.reason}` : ''}
            </span>
          </span>
          <button type="button" className="file-access-revoke" disabled={busyRef === item.ref} aria-label={`撤销 ${item.display_name}`} onClick={() => void revoke(item)}>撤销</button>
        </li>)}
      </ul>}
    <p className="file-access-note"><ShieldCheck size={13} aria-hidden="true" /><span>MCP 每次调用仍需你审批；技能只包含说明文档，不执行代码。撤销后下一轮对话起失效，不影响企业配置。</span></p>
  </section>
}
