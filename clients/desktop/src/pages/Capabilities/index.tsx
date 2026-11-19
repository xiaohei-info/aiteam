/**
 * 左侧栏「能力」页：成员本人的个人 MCP 与技能（只在本机、只对本人会话生效）。
 * - MCP：添加 MCP（粘贴配置 / 检查鉴权 / 登录或填令牌）、鉴权状态、重新登录 / 更新令牌 / 退出登录、撤销
 * - 技能：添加技能（企业开放给本人的技能目录）、升级、撤销
 * - 自动安装授权（设计 §11.3）的查看与撤销
 * 原先在「设置」页里，现在单独成页；设置页只留一行链接。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, BookOpen, ExternalLink, FolderOpen, LoaderCircle, LogIn, Plug, Plus, ShieldCheck, Trash2, Zap } from 'lucide-react'
import '../../components/FileAccess/FileAccess.css'
import '../Settings/Settings.css'
import './McpAuth.css'
import { agentApi } from '../../api/agent'
import type { CapabilityAutoInstall, LocalCapability, LocalCapabilityKind, McpLogin } from '../../api/agent/types'
import { autoInstallKindLabel, capabilitySourceLabel, capabilitySourceTone, customSkillIntegrityLabel, hasLocalDirectory, isAutoInstalled, mcpAuthStatusLabel } from './capabilityLabels'
import { revealInFileManager } from '../../lib/externalOpen'
import { isMacUserAgent } from '../../lib/projectConversation'
import { AddMcpDialog, McpSignInDialog, McpTokenDialog } from './McpAuthDialogs'
import { AddSkillDialog } from './AddSkillDialog'

type Dialog = { type: 'add-mcp' } | { type: 'add-skill' } | { type: 'login'; item: LocalCapability; login: McpLogin } | { type: 'token'; item: LocalCapability }

export default function Capabilities() {
  const [items, setItems] = useState<LocalCapability[] | null>(null)
  // 自动安装授权；旧版 Agent 没有该接口时为空列表，不影响已装能力。
  const [grants, setGrants] = useState<CapabilityAutoInstall[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const alive = useRef(true)
  // 挂载时置回 true：开发版 StrictMode 会先卸载再挂载一次，只在卸载时置 false 会让请求结果永远写不回页面。
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async () => {
    const [rows, autoInstall] = await Promise.allSettled([agentApi.listLocalCapabilities(), agentApi.listCapabilityAutoInstall()])
    if (!alive.current) return
    if (rows.status === 'fulfilled') { setItems(rows.value); setError('') }
    else setError(rows.reason instanceof Error ? rows.reason.message : '个人能力读取失败')
    setGrants(autoInstall.status === 'fulfilled' ? autoInstall.value : [])
  }, [])
  useEffect(() => { void load() }, [load])

  const run = async (key: string, action: () => Promise<void>, failure: string) => {
    setBusyKey(key)
    setError('')
    setNotice('')
    try {
      await action()
      await load()
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : failure)
    } finally {
      if (alive.current) setBusyKey(null)
    }
  }
  const keyOf = (item: LocalCapability) => `${item.kind}:${item.ref}`
  const revoke = (item: LocalCapability) => run(keyOf(item), () => agentApi.deleteLocalCapability(item.kind, item.ref), '撤销失败')
  const relogin = (item: LocalCapability) => run(keyOf(item), async () => {
    const login = await agentApi.startMcpLogin(item.ref)
    if (login) setDialog({ type: 'login', item, login })
    else setNotice(`${item.display_name} 的登录仍然有效，无需重新登录。`)
  }, '重新登录失败')
  const signOut = (item: LocalCapability) => run(keyOf(item), () => agentApi.deleteMcpCredential(item.ref), item.auth === 'bearer' ? '清除令牌失败' : '退出登录失败')
  const revokeGrant = (kind: LocalCapabilityKind) => run(`auto:${kind}`, () => agentApi.deleteCapabilityAutoInstall(kind), '撤销授权失败')
  /** 在文件管理器中显示本机技能目录（仅本人导入的技能有）。 */
  const reveal = async (item: LocalCapability) => {
    try {
      const path = await agentApi.getLocalSkillPath(item.ref)
      if (!path) { setError('这个技能没有可显示的本机目录。'); return }
      await revealInFileManager(path)
    } catch (error) { setError(error instanceof Error && error.message ? error.message : '打不开文件管理器') }
  }
  const closeAndReload = () => { setDialog(null); void load() }

  const mcps = (items ?? []).filter((item) => item.kind === 'mcp')
  const skills = (items ?? []).filter((item) => item.kind === 'skill')
  const loading = items === null && !error

  const row = (item: LocalCapability) => {
    const busy = busyKey === keyOf(item)
    const status = mcpAuthStatusLabel(item)
    const integrity = customSkillIntegrityLabel(item)
    return <li key={keyOf(item)}>
      <span className="file-access-directory-icon">{item.kind === 'skill'
        ? <BookOpen size={17} strokeWidth={1.7} aria-hidden="true" />
        : <Plug size={17} strokeWidth={1.7} aria-hidden="true" />}</span>
      <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 4 }}>
        <strong style={{ color: 'var(--text-primary)', fontSize: 13, overflowWrap: 'anywhere' }}>{item.display_name}</strong>
        <span className="cap-meta">
          <span className={`cap-source-badge tone-${capabilitySourceTone(item)}`} title={`来源：${capabilitySourceLabel(item)}`}>
            <span className="cap-source-dot" aria-hidden="true" />{capabilitySourceLabel(item)}
          </span>
          {item.version && <span className="cap-meta-text">版本 {item.version}</span>}
          {isAutoInstalled(item) && <span className="cap-meta-text">自动安装</span>}
          {status && <span className={`cap-pill ${status.attention ? 'attention' : ''}`}>{status.text}</span>}
          {integrity && <span className={`cap-pill ${integrity.attention ? 'attention' : ''}`}>{integrity.text}</span>}
        </span>
        {item.kind === 'mcp' && <span className="file-access-directory-path" title={item.url}>{item.url}</span>}
        <span style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
          {item.kind === 'skill' ? `标识：${item.ref}` : `工具：${item.tools.join('、') || '—'}`}{item.reason ? ` · 原因：${item.reason}` : ''}
        </span>
      </span>
      <span className="mcp-row-actions">
        {item.kind === 'mcp' && item.auth === 'oauth' && <>
          <button type="button" className="cap-action" disabled={busy} onClick={() => void relogin(item)}><LogIn size={12} aria-hidden="true" />重新登录</button>
          {item.auth_status === 'signed_in' && <button type="button" className="cap-action" disabled={busy} onClick={() => void signOut(item)}>退出登录</button>}
        </>}
        {item.kind === 'mcp' && item.auth === 'bearer' && <>
          <button type="button" className="cap-action" disabled={busy} onClick={() => setDialog({ type: 'token', item })}>更新令牌</button>
          {item.auth_status === 'token_set' && <button type="button" className="cap-action" disabled={busy} onClick={() => void signOut(item)}>清除令牌</button>}
        </>}
        {item.kind === 'mcp' && <button type="button" className="cap-action" disabled={busy} onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')} title={item.url}><ExternalLink size={12} aria-hidden="true" />打开服务</button>}
        {hasLocalDirectory(item) && <button type="button" className="cap-action" disabled={busy} onClick={() => void reveal(item)}><FolderOpen size={12} aria-hidden="true" />{isMacUserAgent(navigator.userAgent) ? '在 Finder 中显示' : '在文件资源管理器中显示'}</button>}
        <button type="button" className="cap-action danger" disabled={busy} onClick={() => void revoke(item)}><Trash2 size={12} aria-hidden="true" />撤销</button>
      </span>
    </li>
  }

  const section = (kind: LocalCapabilityKind, list: LocalCapability[]) => {
    const mcp = kind === 'mcp'
    const Icon = mcp ? Plug : BookOpen
    return <section className="settings-card glass-panel" aria-labelledby={`capabilities-${kind}-title`}>
      <div className="settings-section-heading">
        <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
        <div>
          <h2 id={`capabilities-${kind}-title`}>{mcp ? 'MCP' : '技能'}</h2>
          <p>{mcp
            ? '连接外部服务的工具。可以自己添加，或在对话中员工请求时由你批准安装；需要登录的服务，令牌只加密保存在本机。'
            : '企业开放给你的说明文档类技能，也可以导入自己的技能（文件夹 / zip / 粘贴 / 网址）。安装后下一轮对话起可用。'}</p>
        </div>
        <span className="capabilities-heading-action">
          {items && <span className={`file-access-status ${list.length ? 'granted' : ''}`} style={{ marginLeft: 0 }}>{list.length ? `已安装 ${list.length} 个` : '未安装'}</span>}
          <button type="button" className="capabilities-add" onClick={() => setDialog({ type: mcp ? 'add-mcp' : 'add-skill' })}>
            <Plus size={13} aria-hidden="true" />{mcp ? '添加 MCP' : '添加技能'}
          </button>
        </span>
      </div>
      {loading ? <p className="file-access-note" role="status"><LoaderCircle className="file-access-spinner" size={14} aria-hidden="true" />正在读取…</p>
        : items && list.length === 0 ? <div className="file-access-empty">
          <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
          <div><strong>{mcp ? '还没有安装 MCP' : '还没有安装技能'}</strong><p>{mcp ? '点右上角「添加 MCP」，粘贴服务方给的配置或地址即可。' : '点右上角「添加技能」，从企业开放的技能里选，或导入你自己的技能。'}</p></div>
        </div>
          : items && <ul className="file-access-grants" aria-label={mcp ? '已安装的 MCP' : '已安装的技能'}>{list.map(row)}</ul>}
    </section>
  }

  return <div className="settings-page">
    <div className="settings-content">
      {error && <p role="alert" className="file-access-error"><AlertCircle size={14} aria-hidden="true" /><span>{error}</span></p>}
      {notice && <p role="status" className="file-access-note"><ShieldCheck size={13} aria-hidden="true" /><span>{notice}</span></p>}
      {section('mcp', mcps)}
      {section('skill', skills)}
      {grants.length > 0 && <section className="settings-card glass-panel" aria-labelledby="capabilities-auto-title">
        <div className="settings-section-heading">
          <Zap size={16} strokeWidth={1.7} aria-hidden="true" />
          <div><h2 id="capabilities-auto-title">自动安装授权</h2><p>只对平台目录来源生效；企业自建技能与手动地址的 MCP 仍每次询问。撤销后恢复为每次询问，已装的不受影响。</p></div>
        </div>
        <ul className="file-access-grants" aria-label="自动安装授权">
          {grants.map((grant) => <li key={`auto:${grant.kind}`}>
            <span className="file-access-directory-icon"><Zap size={17} strokeWidth={1.7} aria-hidden="true" /></span>
            <strong style={{ flex: 1, minWidth: 0, color: 'var(--text-primary)', fontSize: 13 }}>{autoInstallKindLabel(grant.kind)}</strong>
            <button type="button" className="file-access-revoke" disabled={busyKey === `auto:${grant.kind}`} aria-label={`撤销${autoInstallKindLabel(grant.kind)}的授权`} onClick={() => void revokeGrant(grant.kind)}>撤销授权</button>
          </li>)}
        </ul>
      </section>}
      <p className="file-access-note"><ShieldCheck size={13} aria-hidden="true" /><span>MCP 每次调用仍需你审批；技能只包含说明文档，不执行代码。撤销后下一轮对话起失效，不影响企业配置。</span></p>
    </div>
    {dialog?.type === 'add-mcp' && <AddMcpDialog onInstalled={() => void load()} onClose={() => setDialog(null)} />}
    {dialog?.type === 'add-skill' && <AddSkillDialog installed={items ?? []} onInstalled={load} onClose={() => setDialog(null)} />}
    {dialog?.type === 'login' && <McpSignInDialog item={dialog.item} login={dialog.login} onCompleted={closeAndReload} onClose={closeAndReload} />}
    {dialog?.type === 'token' && <McpTokenDialog item={dialog.item} onSaved={closeAndReload} onClose={() => setDialog(null)} />}
  </div>
}
