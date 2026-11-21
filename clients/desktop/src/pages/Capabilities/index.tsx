/**
 * 左侧栏「能力」页：成员本人的个人 MCP 与技能（只在本机、只对本人会话生效）。
 * - MCP：添加 MCP（从企业拿一键安装 / 粘贴配置、检查鉴权、登录或填令牌）、鉴权状态、重新登录 / 更新令牌 / 退出登录、撤销
 * - 技能：添加技能（企业开放给本人的技能目录）、升级、撤销
 * - 企业目录里有新版本的：行内「有更新」+「更新」，顶部「N 项有更新 · 全部更新」（设计「技能MCP命名空间出处与更新提示」§4.5）；
 *   新版本下一条消息起生效，不推送、不弹窗；侧栏「能力」与「MCP」「技能」标题的红点见 stores/capabilityUpdates（§4.5b）
 * - 自动安装授权（设计 §11.3）的查看与撤销
 * 原先在「设置」页里，现在单独成页；设置页只留一行链接。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, BookOpen, ExternalLink, FolderOpen, LoaderCircle, LogIn, Plug, Plus, RefreshCw, ShieldCheck, Trash2, UserRound, Zap } from 'lucide-react'
import '../../components/FileAccess/FileAccess.css'
import '../Settings/Settings.css'
import './McpAuth.css'
import { agentApi } from '../../api/agent'
import type { CapabilityAutoInstall, CapabilityProvenance, CatalogMcp, InstallableSkill, LocalCapability, LocalCapabilityKind, McpLogin } from '../../api/agent/types'
import { autoInstallKindLabel, capabilityTitle, capabilitySourceLabel, capabilitySourceTone, customSkillIntegrityLabel, hasLocalDirectory, isAutoInstalled, mcpAuthStatusLabel, provenanceText } from './capabilityLabels'
import { revealInFileManager } from '../../lib/externalOpen'
import { isMacUserAgent } from '../../lib/projectConversation'
import { AddMcpDialog, McpSignInDialog, McpTokenDialog } from './McpAuthDialogs'
import { AddSkillDialog } from './AddSkillDialog'
import { AskEmployeeDialog } from './AskEmployeeDialog'
import { useChatStore } from '../../stores/chat'
import { useCapabilityUpdatesStore } from '../../stores/capabilityUpdates'
import { capabilityUpdateLabel } from '../../lib/capabilityUpdates'
import { useNavigate } from 'react-router-dom'

/** 一个已装能力在企业目录里的对应条目：用来显示前缀 / 出处，以及有没有新版本。 */
type CatalogMatch = { kind: 'skill'; entry: InstallableSkill } | { kind: 'mcp'; entry: CatalogMcp }

function catalogMatches(skills: InstallableSkill[], mcps: CatalogMcp[]): Map<string, CatalogMatch> {
  const map = new Map<string, CatalogMatch>()
  for (const entry of skills) {
    if ((entry.state === 'installed' || entry.state === 'update') && entry.local_ref) map.set(`skill:${entry.local_ref}`, { kind: 'skill', entry })
  }
  for (const entry of mcps) {
    if (entry.state === 'installed' || entry.state === 'update') map.set(`mcp:${entry.ref}`, { kind: 'mcp', entry })
  }
  return map
}

function hasUpdate(match: CatalogMatch | undefined): boolean {
  return match?.entry.state === 'update'
}

function Provenance({ provenance }: { provenance: CapabilityProvenance | null | undefined }) {
  const text = provenanceText(provenance)
  if (!text) return null
  return provenance?.url
    ? <a className="cap-meta-text cap-origin-link" href={provenance.url} target="_blank" rel="noopener noreferrer"
      onClick={(event) => { event.preventDefault(); window.open(provenance.url, '_blank', 'noopener,noreferrer') }}>{text} ↗</a>
    : <span className="cap-meta-text">{text}</span>
}

type Dialog = { type: 'add-mcp' } | { type: 'add-skill' } | { type: 'ask-employee' } | { type: 'login'; item: LocalCapability; login: McpLogin } | { type: 'token'; item: LocalCapability }

export default function Capabilities() {
  const [items, setItems] = useState<LocalCapability[] | null>(null)
  // 自动安装授权；旧版 Agent 没有该接口时为空列表，不影响已装能力。
  const [grants, setGrants] = useState<CapabilityAutoInstall[]>([])
  // 企业目录（读不到不影响已装能力，只是不显示前缀 / 更新）。
  const [catalogSkills, setCatalogSkills] = useState<InstallableSkill[]>([])
  const [catalogMcps, setCatalogMcps] = useState<CatalogMcp[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const alive = useRef(true)
  const navigate = useNavigate()
  const employees = useChatStore((state) => state.workbenchEmployees)
  const refreshConversations = useChatStore((state) => state.refreshConversations)
  const addConversation = useChatStore((state) => state.addConversation)
  const setActiveConvId = useChatStore((state) => state.setActiveConvId)
  // 挂载时置回 true：开发版 StrictMode 会先卸载再挂载一次，只在卸载时置 false 会让请求结果永远写不回页面。
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async () => {
    const [rows, autoInstall, skillCatalog, mcpCatalog] = await Promise.allSettled([
      agentApi.listLocalCapabilities(), agentApi.listCapabilityAutoInstall(), agentApi.listInstallableSkills(), agentApi.listInstallableMcpServers(),
    ])
    if (!alive.current) return
    setCatalogSkills(skillCatalog.status === 'fulfilled' ? skillCatalog.value : [])
    setCatalogMcps(mcpCatalog.status === 'fulfilled' ? mcpCatalog.value : [])
    if (skillCatalog.status === 'fulfilled' && mcpCatalog.status === 'fulfilled') useCapabilityUpdatesStore.getState().setCatalog(skillCatalog.value, mcpCatalog.value)
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
  const matches = catalogMatches(catalogSkills, catalogMcps)
  const updates = (items ?? []).filter((item) => hasUpdate(matches.get(keyOf(item))))
  /** 换成企业目录的当前版本；OAuth 的 MCP 可能要重新登录：返回 false 并打开登录窗口。 */
  const applyUpdate = async (item: LocalCapability): Promise<boolean> => {
    const match = matches.get(keyOf(item))
    if (!match) return true
    if (match.kind === 'skill') { await agentApi.installSkill(match.entry.skill_id, true); return true }
    const result = await agentApi.installCatalogMcpServer(match.entry.server_id, { replace: true })
    if (result.login) { setDialog({ type: 'login', item, login: result.login }); return false }
    return true
  }
  const updateOne = (item: LocalCapability) => run(keyOf(item), async () => {
    if (await applyUpdate(item)) setNotice(`已更新「${item.display_name}」，下一条消息起用新版本。`)
  }, '更新失败')
  /** 逐个更新；遇到要登录的停下打开登录窗口，失败的停下说明是哪一个。 */
  const updateAll = () => run('update:all', async () => {
    let done = 0
    for (const item of updates) {
      try {
        if (!(await applyUpdate(item))) { setNotice(done ? `已更新 ${done} 项；「${item.display_name}」需要重新登录，登录完成后即更新好。` : ''); return }
      } catch (err) {
        throw new Error(`${done ? `已更新 ${done} 项；` : ''}「${item.display_name}」更新失败：${err instanceof Error && err.message ? err.message : '请重试'}`)
      }
      done += 1
    }
    setNotice(`已更新 ${done} 项，下一条消息起用新版本。`)
  }, '更新失败')
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
  /** 新开会话并把需求发出去；然后跳到那个会话，用户在那里看到员工判断与审批。 */
  const sendToEmployee = async (conversationId: string, text: string, employeeId: string, title: string) => {
    const employee = employees.find((item) => item.employeeId === employeeId)
    setDialog(null)
    setActiveConvId(conversationId)
    addConversation({
      id: conversationId,
      title,
      agentEmoji: '🤖',
      agentName: employee?.displayName ?? '员工',
      lastMessage: '',
      time: '',
      _employeeId: employeeId,
    })
    navigate('/chat', { state: { employeeId, conversationId, agentName: employee?.displayName, initialMessage: text, titleFromEmployee: true, refreshWorkbench: true } })
    void refreshConversations().catch(console.error)
  }

  const mcps = (items ?? []).filter((item) => item.kind === 'mcp')
  const skills = (items ?? []).filter((item) => item.kind === 'skill')
  const loading = items === null && !error

  const row = (item: LocalCapability) => {
    const busy = busyKey === keyOf(item)
    const status = mcpAuthStatusLabel(item)
    const integrity = customSkillIntegrityLabel(item)
    const match = matches.get(keyOf(item))
    const update = hasUpdate(match)
    const title = capabilityTitle(match?.entry.namespace, item.display_name)
    return <li key={keyOf(item)}>
      <span className="file-access-directory-icon">{item.kind === 'skill'
        ? <BookOpen size={17} strokeWidth={1.7} aria-hidden="true" />
        : <Plug size={17} strokeWidth={1.7} aria-hidden="true" />}</span>
      <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 4 }}>
        <strong style={{ color: 'var(--text-primary)', fontSize: 13, overflowWrap: 'anywhere' }}>{title}</strong>
        <span className="cap-meta">
          <span className={`cap-source-badge tone-${capabilitySourceTone(item)}`} title={`来源：${capabilitySourceLabel(item)}`}>
            <span className="cap-source-dot" aria-hidden="true" />{capabilitySourceLabel(item)}
          </span>
          {item.version && <span className="cap-meta-text">版本 {item.version}</span>}
          {isAutoInstalled(item) && <span className="cap-meta-text">自动安装</span>}
          {status && <span className={`cap-pill ${status.attention ? 'attention' : ''}`}>{status.text}</span>}
          {integrity && <span className={`cap-pill ${integrity.attention ? 'attention' : ''}`}>{integrity.text}</span>}
          {update && <span className="cap-pill update">有更新</span>}
          {match?.kind === 'skill' && <Provenance provenance={match.entry.provenance} />}
        </span>
        {item.kind === 'mcp' && <span className="file-access-directory-path" title={item.url}>{item.url}</span>}
        <span style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
          {item.kind === 'skill' ? `标识：${item.ref}` : `工具：${item.tools.join('、') || '—'}`}{item.reason ? ` · 原因：${item.reason}` : ''}
        </span>
      </span>
      <span className="mcp-row-actions">
        {update && <button type="button" className="cap-action primary" disabled={busy || busyKey === 'update:all'} onClick={() => void updateOne(item)}>
          <RefreshCw size={12} aria-hidden="true" />{busy ? '正在更新…' : '更新'}
        </button>}
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
      </span>
      {/* 撤销收成右上角的小图标按钮：不占行内空间，也不跟其他操作抢位置。 */}
      <button type="button" className="cap-action danger cap-icon-btn" disabled={busy} aria-label={`撤销 ${item.display_name}`} title="撤销" onClick={() => void revoke(item)}>
        <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </li>
  }

  const section = (kind: LocalCapabilityKind, list: LocalCapability[]) => {
    const mcp = kind === 'mcp'
    const Icon = mcp ? Plug : BookOpen
    const sectionUpdates = list.filter((item) => hasUpdate(matches.get(keyOf(item)))).length
    return <section className="settings-card glass-panel" aria-labelledby={`capabilities-${kind}-title`}>
      <div className="settings-section-heading">
        <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
        <div>
          <h2 id={`capabilities-${kind}-title`} className="cap-section-title">{mcp ? 'MCP' : '技能'}
            {sectionUpdates > 0 && <span className="cap-heading-dot" data-testid={`capabilities-${kind}-update-dot`} title={capabilityUpdateLabel(sectionUpdates)}>
              <span className="sr-only">{capabilityUpdateLabel(sectionUpdates)}</span>
            </span>}
          </h2>
          <p>{mcp
            ? '连接外部服务的工具。可以自己添加，或在对话中员工请求时由你批准安装；需要登录的服务，令牌只加密保存在本机。'
            : '企业开放给你的技能，也可以导入自己的技能（文件夹 / zip / 粘贴 / 网址）。安装后下一条消息起可用。'}</p>
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
          <div><strong>{mcp ? '还没有安装 MCP' : '还没有安装技能'}</strong><p>{mcp ? '点右上角「添加 MCP」，从企业开放的 MCP 里一键安装，或粘贴服务方给的配置或地址。' : '点右上角「添加技能」，从企业开放的技能里选，或导入你自己的技能。'}</p></div>
        </div>
          : items && <ul className="file-access-grants" aria-label={mcp ? '已安装的 MCP' : '已安装的技能'}>{list.map(row)}</ul>}
    </section>
  }

  return <div className="settings-page">
    <div className="settings-content">
      {error && <p role="alert" className="file-access-error"><AlertCircle size={14} aria-hidden="true" /><span>{error}</span></p>}
      {notice && <p role="status" className="file-access-note"><ShieldCheck size={13} aria-hidden="true" /><span>{notice}</span></p>}
      {updates.length > 0 && <div className="cap-update-bar" role="region" aria-label="能力更新">
        <RefreshCw size={14} aria-hidden="true" />
        <span>{updates.length} 项有更新，企业已发布新版本；更新后下一条消息起生效。</span>
        <button type="button" className="capabilities-add" disabled={busyKey !== null} onClick={() => void updateAll()}>
          {busyKey === 'update:all' ? '正在更新…' : '全部更新'}
        </button>
      </div>}
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
      <section className="settings-card glass-panel" aria-labelledby="capabilities-ask-title">
        <div className="settings-section-heading">
          <UserRound size={16} strokeWidth={1.7} aria-hidden="true" />
          <div>
            <h2 id="capabilities-ask-title">让员工帮我装</h2>
            <p>企业目录里没有的能力，交给一个员工去判断和安装。装的是你个人的能力，员工判断完仍要你批准。</p>
          </div>
          <span className="capabilities-heading-action">
            <button type="button" className="capabilities-add" disabled={employees.length === 0} onClick={() => setDialog({ type: 'ask-employee' })}>
              <UserRound size={13} aria-hidden="true" />让员工帮我装
            </button>
          </span>
        </div>
      </section>
      <p className="file-access-note"><ShieldCheck size={13} aria-hidden="true" /><span>MCP 每次调用仍需你审批；技能可能附带脚本和资料，不会自动执行，员工运行命令仍按审批策略。撤销后下一条消息起失效，不影响企业配置。</span></p>
    </div>
    {dialog?.type === 'add-mcp' && <AddMcpDialog onInstalled={() => void load()} onClose={() => setDialog(null)} />}
    {dialog?.type === 'add-skill' && <AddSkillDialog installed={items ?? []} onInstalled={load} onClose={() => setDialog(null)} />}
    {dialog?.type === 'ask-employee' && <AskEmployeeDialog employees={employees} onSent={sendToEmployee} onClose={() => setDialog(null)} />}
    {dialog?.type === 'login' && <McpSignInDialog item={dialog.item} login={dialog.login} onCompleted={closeAndReload} onClose={closeAndReload} />}
    {dialog?.type === 'token' && <McpTokenDialog item={dialog.item} onSaved={closeAndReload} onClose={() => setDialog(null)} />}
  </div>
}
