/**
 * 设置「个人能力」里的 MCP 鉴权窗口（设计 2026-11-18 MCP鉴权与配置导入 §3.6 / §3.9）：
 * - 添加 MCP：「从企业拿」一键安装企业目录里的 MCP（设计 2026-11-20 §4.4b）；
 *   「自定义」粘贴配置识别 → 检查鉴权 → 填令牌或到服务方网页登录 → 本机安装（不经对话与模型）
 * - 登录进度：等待浏览器登录，可让本机 Agent 重新打开登录页 / 复制链接 / 取消
 * - 更新令牌：Agent 先用新令牌读一次工具列表，被拒则不保存
 * 令牌只在桌面端 → 本机 Agent 之间流转，提交后立即从界面清空。
 */
import { useEffect, useRef, useState } from 'react'
import { BadgeCheck, ChevronDown, KeyRound, LogIn, Plug } from 'lucide-react'
import { ChatDialog } from '../../components/Chat/ChatDialog'
import { agentApi, AgentApiError } from '../../api/agent'
import type { LocalCapability, McpLogin } from '../../api/agent/types'
import { parseMcpConfig, type McpConfigCandidate, type McpConfigRejected } from '../../lib/mcpConfigImport'
import { addMcpProblem, addMcpRequest, signInFailureText, type AddMcpForm } from '../../lib/mcpSignIn'
import { alreadyInstalledText } from '../../lib/alreadyInstalled'
import { CatalogMcpPanel } from './CatalogMcpPanel'
import './McpAuth.css'

const errorText = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback

/** 轮询一次登录，直到完成 / 失败；登录记录被 Agent 清理（404）视为已结束。 */
function useLoginProgress(initial: McpLogin, onCompleted: () => void) {
  const [login, setLogin] = useState(initial)
  const done = useRef(onCompleted)
  done.current = onCompleted
  useEffect(() => {
    if (login.status !== 'pending') return
    let stopped = false
    const timer = setInterval(async () => {
      try {
        const next = await agentApi.getMcpLogin(login.login_id)
        if (stopped || !next) return
        setLogin(next)
        if (next.status === 'completed') done.current()
      } catch (error) {
        if (!stopped && error instanceof AgentApiError && error.status === 404) done.current()
      }
    }, 1500)
    return () => { stopped = true; clearInterval(timer) }
  }, [login.login_id, login.status])
  return login
}

/** 等待浏览器登录。完成后由调用方关闭窗口并刷新列表。 */
export function McpSignInPanel({ login: initial, onCompleted, onClose }: { login: McpLogin; onCompleted: () => void; onClose: () => void }) {
  const login = useLoginProgress(initial, onCompleted)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const act = async (run: () => Promise<string | null>) => {
    setBusy(true)
    try { setNote(await run()) } catch (error) { setNote(errorText(error, '操作失败，请重试')) } finally { setBusy(false) }
  }
  if (login.status === 'failed') {
    return <div className="mcp-form">
      <p role="alert" className="mcp-error">{signInFailureText(login.error)}</p>
      <footer><button type="button" onClick={onClose}>关闭</button></footer>
    </div>
  }
  return <div className="mcp-form">
    <p className="mcp-hint">
      <LogIn size={14} aria-hidden="true" />
      <span>已在系统浏览器打开 <strong>{login.auth_host}</strong> 的登录页。请在浏览器里登录并同意授权，完成后这里会自动关闭；令牌只保存在本机。</span>
    </p>
    <div>
      <div className="mcp-label">浏览器没有打开？复制下面的链接到浏览器里打开（10 分钟内有效）：</div>
      <div className="mcp-link" data-testid="mcp-sign-in-url">{login.authorization_url}</div>
    </div>
    {note && <p className="mcp-note" role="status">{note}</p>}
    <footer>
      <button type="button" disabled={busy} onClick={() => void act(async () => { await agentApi.cancelMcpLogin(login.login_id); onClose(); return null })}>取消登录</button>
      <button type="button" onClick={() => void act(async () => { await navigator.clipboard.writeText(login.authorization_url); return '链接已复制。' })}>复制链接</button>
      <button type="button" disabled={busy} onClick={() => void act(async () => (await agentApi.reopenMcpLogin(login.login_id)) ? '已在浏览器重新打开登录页。' : '这次登录已经结束。')}>在浏览器打开</button>
    </footer>
  </div>
}

export function McpSignInDialog({ item, login, onCompleted, onClose }: { item: LocalCapability; login: McpLogin; onCompleted: () => void; onClose: () => void }) {
  return <ChatDialog title={`登录 ${item.display_name}`} description="到服务方网页登录后自动生效" icon={<LogIn size={18} />} className="mcp-dialog" onClose={onClose}>
    <McpSignInPanel login={login} onCompleted={onCompleted} onClose={onClose} />
  </ChatDialog>
}

/** 更新访问令牌。请求头名缺省沿用安装时的设置。 */
export function McpTokenDialog({ item, onSaved, onClose }: { item: LocalCapability; onSaved: () => void; onClose: () => void }) {
  const [token, setToken] = useState('')
  const [header, setHeader] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await agentApi.updateMcpToken(item.ref, { token: token.trim(), ...(header.trim() ? { header: header.trim() } : {}) })
      setToken('')
      onSaved()
    } catch (err) {
      setToken('')
      setError(errorText(err, '保存令牌失败'))
    } finally { setBusy(false) }
  }
  return <ChatDialog title={`更新 ${item.display_name} 的令牌`} description="先用新令牌读一次工具列表，服务方接受才保存" icon={<KeyRound size={18} />} className="mcp-dialog" onClose={onClose}>
    <form className="mcp-form" onSubmit={(event) => { event.preventDefault(); if (token.trim() && !busy) void save() }}>
      <label>访问令牌（只保存在本机，不进入对话、不交给模型）
        <input type="password" autoComplete="off" spellCheck={false} autoFocus value={token} disabled={busy} onChange={(event) => setToken(event.target.value)} />
      </label>
      <label>请求头名（可选）
        <input value={header} disabled={busy} placeholder={item.auth_header || 'Authorization: Bearer'} onChange={(event) => setHeader(event.target.value)} />
      </label>
      {error && <p role="alert" className="mcp-error">{error}</p>}
      <footer>
        <button type="button" onClick={onClose}>取消</button>
        <button type="submit" disabled={!token.trim() || busy}>{busy ? '正在验证…' : '保存令牌'}</button>
      </footer>
    </form>
  </ChatDialog>
}

const EMPTY: AddMcpForm = { ref: '', displayName: '', url: '', timeoutMs: 30000, reason: '', auth: null, token: '', header: '', clientId: '', clientSecret: '', replace: false }
const AUTH_TEXT = { none: '无需登录', oauth: '需要登录服务方账号', bearer: '需要访问令牌' } as const

type McpSourceTab = 'catalog' | 'custom'

/** 添加个人 MCP：成员本人在设置里添加，不经对话与模型。默认「从企业拿」，「自定义」为粘贴配置。 */
export function AddMcpDialog({ onInstalled, onClose }: { onInstalled: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<McpSourceTab>('catalog')
  const [login, setLogin] = useState<{ login: McpLogin; name: string } | null>(null)
  /** 自定义添加完成：只给成功界面，不再显示表单与添加按钮。 */
  const [done, setDone] = useState('')

  if (login) {
    return <ChatDialog title={`登录 ${login.name}`} description="登录完成后自动安装" icon={<LogIn size={18} />} className="mcp-dialog" onClose={onClose}>
      <McpSignInPanel login={login.login} onCompleted={() => { onInstalled(); onClose() }} onClose={onClose} />
    </ChatDialog>
  }
  if (done) {
    return <ChatDialog title="添加 MCP" description="只装在本机、只对你自己的会话生效" icon={<Plug size={18} />} className="mcp-dialog" onClose={onClose}>
      <div className="skill-success" aria-label="添加结果">
        <p className="skill-success-title"><BadgeCheck size={16} aria-hidden="true" />添加完成</p>
        <ul><li>{done}</li></ul>
        <footer><button type="button" className="skill-install" onClick={onClose}>完成</button></footer>
      </div>
    </ChatDialog>
  }
  const onLogin = (next: McpLogin, name: string) => setLogin({ login: next, name })
  return <ChatDialog title="添加 MCP" description="从企业拿，或粘贴配置自己添加；只装在本机、只对你自己的会话生效" icon={<Plug size={18} />} className="mcp-dialog" onClose={onClose}>
    <div className="mcp-form">
      <div className="skill-source-tabs" role="tablist" aria-label="MCP 来源">
        <button type="button" role="tab" aria-selected={tab === 'catalog'} className={tab === 'catalog' ? 'on' : ''} onClick={() => setTab('catalog')}>从企业拿</button>
        <button type="button" role="tab" aria-selected={tab === 'custom'} className={tab === 'custom' ? 'on' : ''} onClick={() => setTab('custom')}>自定义</button>
      </div>
      {tab === 'catalog'
        ? <CatalogMcpPanel onInstalled={onInstalled} onLogin={onLogin} onClose={onClose} />
        : <CustomMcpPanel onInstalled={onInstalled} onLogin={onLogin} onDone={setDone} onClose={onClose} />}
    </div>
  </ChatDialog>
}

/** 「自定义」：粘贴配置或手填地址，检查鉴权后安装。 */
function CustomMcpPanel({ onInstalled, onLogin, onDone, onClose }: {
  onInstalled: () => void
  onLogin: (login: McpLogin, name: string) => void
  onDone: (text: string) => void
  onClose: () => void
}) {
  const [paste, setPaste] = useState('')
  const [imported, setImported] = useState<{ servers: McpConfigCandidate[]; rejected: McpConfigRejected[]; droppedSecret: boolean } | null>(null)
  const [form, setForm] = useState<AddMcpForm>(EMPTY)
  const [probedUrl, setProbedUrl] = useState('')
  const [authHost, setAuthHost] = useState('')
  const [clash, setClash] = useState(false)
  /** 撞同名已装：展示为状态，不是错误。 */
  const [installed, setInstalled] = useState('')
  const [busy, setBusy] = useState<'probe' | 'install' | null>(null)
  const [error, setError] = useState('')
  const set = (patch: Partial<AddMcpForm>) => setForm((current) => ({ ...current, ...patch }))

  const choose = (server: McpConfigCandidate) => {
    setForm({ ...EMPTY, ref: server.ref, displayName: server.name, url: server.url, timeoutMs: server.timeout_ms ?? 30000, auth: server.auth ?? null, header: server.auth_header ?? '' })
    setProbedUrl('')
    setAuthHost('')
    setClash(false)
    setError('')
  }
  const recognize = () => {
    const result = parseMcpConfig(paste)
    // 不论成功与否都清空粘贴框：配置里可能带着令牌。
    setPaste('')
    if (!result.ok) { setImported(null); setError(result.error); return }
    setImported({ servers: result.servers, rejected: result.rejected, droppedSecret: result.servers.some((s) => s.droppedSecret) })
    if (result.servers[0]) choose(result.servers[0])
    else setError('配置里没有可用的 MCP 服务')
  }
  const probe = async (): Promise<AddMcpForm['auth']> => {
    const url = form.url.trim()
    setBusy('probe')
    setError('')
    try {
      const result = await agentApi.probeMcpServer(url)
      const auth = result?.auth ?? 'none'
      setForm((current) => ({ ...current, auth }))
      setAuthHost(result?.auth_host ?? '')
      setProbedUrl(url)
      return auth
    } catch (err) {
      setError(errorText(err, '无法连接这个地址'))
      return null
    } finally { setBusy(null) }
  }
  const install = async () => {
    let current = form
    if (probedUrl !== form.url.trim()) {
      const auth = await probe()
      if (!auth) return
      current = { ...form, auth }
      if (auth === 'bearer' && !form.token.trim()) { setError('这个 MCP 需要访问令牌，请填写服务方发的令牌后再添加'); return }
    }
    const problem = addMcpProblem(current)
    if (problem) { setError(problem); return }
    setBusy('install')
    setError('')
    try {
      const result = await agentApi.installMcpServer(addMcpRequest(current))
      set({ token: '', clientSecret: '' })
      if (result.login) onLogin(result.login, current.displayName || current.ref)
      else { onDone(`已添加「${current.displayName || current.ref}」`); onInstalled() }
    } catch (err) {
      set({ token: '' })
      // 撞同名已装：不是失败，是「已经装好了」的状态；同时给出覆盖入口。
      const already = alreadyInstalledText(err)
      if (already) { setClash(true); setInstalled(already); setError('') }
      else setError(errorText(err, '添加失败'))
    } finally { setBusy(null) }
  }

  const problem = form.url.trim() ? addMcpProblem({ ...form, auth: form.auth === 'bearer' ? 'bearer' : null }) : '请填写 MCP 地址'
  const disabled = busy !== null
  return <form className="mcp-form" onSubmit={(event) => { event.preventDefault(); if (!problem && !disabled) void install() }}>
      <label>粘贴配置（可选）
        <textarea
          rows={4} spellCheck={false} value={paste} disabled={disabled}
          placeholder={'"cr-test": {\n  "type": "streamableHttp",\n  "url": "https://…",\n  "timeout": 30000\n}'}
          onChange={(event) => setPaste(event.target.value)}
        />
        <span className="mcp-note">支持 Claude / Cursor / VS Code 的 mcpServers 配置、单条配置或链接；只支持 streamable HTTP 远程服务。识别后粘贴框会清空，配置里的令牌不会保存。</span>
      </label>
      <div><button type="button" disabled={!paste.trim() || disabled} onClick={recognize}>识别配置</button></div>
      {imported && <div className="mcp-imported" role="status">
        {imported.servers.length > 1 && <div className="mcp-choices" aria-label="选择要添加的 MCP">
          {imported.servers.map((server) => <button key={`${server.ref}:${server.url}`} type="button" aria-pressed={server.url === form.url && server.ref === form.ref} onClick={() => choose(server)}>{server.name || server.ref}</button>)}
        </div>}
        {imported.droppedSecret && <p className="mcp-note">配置里带的令牌没有保存，请在下方重新填写。</p>}
        {imported.rejected.map((item) => <p key={item.name} className="mcp-note">已跳过 {item.name}：{item.reason}</p>)}
      </div>}
      <label>MCP 地址
        <input value={form.url} disabled={disabled} spellCheck={false} placeholder="https://…" onChange={(event) => set({ url: event.target.value })} />
      </label>
      <div className="mcp-row">
        <label>标识
          <input value={form.ref} disabled={disabled} spellCheck={false} placeholder="例如 cr-test" onChange={(event) => { set({ ref: event.target.value }); setClash(false) }} />
        </label>
        <label>名称（可选）
          <input value={form.displayName} disabled={disabled} onChange={(event) => set({ displayName: event.target.value })} />
        </label>
      </div>
      <div className="mcp-row">
        <label>调用超时（毫秒）
          <input inputMode="numeric" value={form.timeoutMs ?? ''} disabled={disabled} onChange={(event) => set({ timeoutMs: event.target.value.trim() ? Number(event.target.value) : null })} />
        </label>
        <label>用途备注（可选）
          <input value={form.reason} disabled={disabled} onChange={(event) => set({ reason: event.target.value })} />
        </label>
      </div>
      <div className="mcp-auth-line">
        <span>鉴权：{form.auth ? <strong>{AUTH_TEXT[form.auth]}{form.auth === 'oauth' && authHost ? `（${authHost}）` : ''}</strong> : '尚未检查'}{probedUrl && probedUrl !== form.url.trim() ? '（地址已改，需重新检查）' : ''}</span>
        <button type="button" disabled={!form.url.trim() || disabled} onClick={() => void probe()}>{busy === 'probe' ? '正在检查…' : '检查鉴权'}</button>
      </div>
      {form.auth === 'oauth' && <p className="mcp-hint"><LogIn size={14} aria-hidden="true" /><span>点「添加并登录」后用系统浏览器打开服务方登录页，登录完成后自动安装；令牌只保存在本机。</span></p>}
      {form.auth === 'bearer' && <div className="mcp-row">
        <label>访问令牌（只保存在本机）
          <input type="password" autoComplete="off" spellCheck={false} value={form.token} disabled={disabled} onChange={(event) => set({ token: event.target.value })} />
        </label>
        <label>请求头名（可选）
          <input value={form.header} disabled={disabled} placeholder="Authorization: Bearer" onChange={(event) => set({ header: event.target.value })} />
        </label>
      </div>}
      {form.auth !== 'bearer' && <details className="mcp-advanced">
        <summary><ChevronDown size={14} aria-hidden="true" />高级：服务方不允许自动注册时，填写服务方发的应用编号</summary>
        <div className="mcp-row">
          <label>应用编号（client_id）
            <input value={form.clientId} disabled={disabled} spellCheck={false} onChange={(event) => set({ clientId: event.target.value })} />
          </label>
          <label>应用密钥（可选，只保存在本机）
            <input type="password" autoComplete="off" value={form.clientSecret} disabled={disabled} onChange={(event) => set({ clientSecret: event.target.value })} />
          </label>
        </div>
      </details>}
      {installed && <p className="mcp-note installed-note" role="status"><BadgeCheck size={14} aria-hidden="true" />{installed}</p>}
      {clash && <label className="mcp-check">
        <input type="checkbox" checked={form.replace} disabled={disabled} onChange={(event) => set({ replace: event.target.checked })} />
        <span>用这个配置替换已装的那个（连它的凭据一起换）</span>
      </label>}
      {(error || problem) && <p role={error ? 'alert' : undefined} className={error ? 'mcp-error' : 'mcp-note'}>{error || problem}</p>}
      <footer>
        <button type="button" onClick={onClose}>取消</button>
        <button type="submit" disabled={Boolean(problem) || disabled}>{busy === 'install' ? '正在添加…' : form.auth === 'oauth' ? '添加并登录' : '添加'}</button>
      </footer>
  </form>
}
