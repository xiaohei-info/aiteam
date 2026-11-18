/**
 * 工具权限审批全局弹窗（页面居中，唯一决策入口）。
 *
 * 链路：agent 触发 → 所属会话 SSE(approval_required) → 本弹窗。
 * 决策回传锚定触发会话：POST /conversations/:id/approvals/:approvalId/decision。
 *
 * UI 约定：
 * - 居中模态，遮罩不响应点击（审批必须显式决策，防误触）
 * - 按钮文案恒定（允许/拒绝），提交中仅用 spinner 表达，不变文字
 * - 多条审批在弹窗内排队，一次展示一条，右上角显示进度
 * - MCP 鉴权（2026-11-18）：需要访问令牌的在弹窗里填令牌，令牌随决定只交给本机 Agent；
 *   需要浏览器登录的点「允许并登录」后弹窗转为等待登录（可重新打开登录页 / 复制链接 / 取消），
 *   等待登录不挡住新来的审批。
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, KeyRound, LogIn, ShieldAlert, Terminal, FilePenLine, FilePlus2, Globe, Wrench, X } from 'lucide-react'
import { agentApi } from '../../api/agent'
import type { McpLogin } from '../../api/agent/types'
import { useApprovalStore, type DecideOptions, type PendingApproval } from '../../stores/approvals'
import { signInFailureText } from '../../lib/mcpSignIn'
import { parseCapabilityInstall, renameProblem, type CapabilityInstallPreview } from './capabilityInstall'

const riskMeta: Record<string, { label: string; icon: typeof Terminal; tone: string }> = {
  bash: { label: '执行本机命令', icon: Terminal, tone: '#ff6666' },
  write: { label: '写入文件', icon: FilePlus2, tone: '#ffaa44' },
  edit: { label: '修改文件', icon: FilePenLine, tone: '#ffaa44' },
  external: { label: '访问外部资源', icon: Globe, tone: '#4488ff' },
  unknown: { label: '工具调用', icon: Wrench, tone: 'var(--text-muted)' },
}

/** 圆形倒计时环：以收到事件时的实际有效时长为满刻度，≤10s 变红 */
const RING_R = 15
const RING_CIRC = 2 * Math.PI * RING_R

function remainingSeconds(item: PendingApproval, now: number): number | null {
  if (!item.expiresAt) return null
  const ms = Date.parse(item.expiresAt) - now
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : null
}

function formatRemain(seconds: number): string {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : String(seconds)
}

function CountdownRing({ remain, total, tone }: { remain: number; total: number; tone: string }) {
  const color = remain <= 10 ? '#ff6666' : tone
  const fraction = Math.min(1, remain / Math.max(1, total))
  const label = formatRemain(remain)
  return (
    <div style={{ position: 'relative', width: 40, height: 40, flexShrink: 0 }} title={`${label} 后过期`}>
      <svg width="40" height="40" viewBox="0 0 40 40" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="20" cy="20" r={RING_R} fill="none" stroke="var(--surface-3)" strokeWidth="3" />
        <circle
          cx="20" cy="20" r={RING_R} fill="none"
          stroke={color} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={RING_CIRC}
          strokeDashoffset={RING_CIRC * (1 - fraction)}
          style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s' }}
        />
      </svg>
      <span style={{
        position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        fontSize: label.length > 3 ? 9 : 11, fontFamily: 'monospace', fontWeight: 600, color,
      }}>
        {label}
      </span>
    </div>
  )
}

/**
 * 安装个人能力。MCP：地址完整显示（不截断、不限高），主机名突出；名称与理由是模型写的，单独标注。
 * 技能：来自企业技能目录，显示名称与版本。与已装同名能力冲突时给出冲突说明，由下方按钮选择覆盖 / 改名 / 取消。
 */
function InstallPreview({ preview }: { preview: CapabilityInstallPreview }) {
  const label: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }
  const clash = preview.replaces
  return (
    <div style={{ padding: '0 20px', display: 'grid', gap: 10 }}>
      {clash && (
        <div role="alert" style={{ fontSize: 12, lineHeight: 1.6, color: '#ffaa44', border: '1px solid color-mix(in srgb, #ffaa44 40%, transparent)', borderRadius: 8, padding: '8px 12px', background: 'color-mix(in srgb, #ffaa44 10%, var(--surface-2))' }}>
          {preview.kind === 'skill' ? (
            <>已安装「{clash.displayName}」{clash.version ? ` ${clash.version} 版` : ''}。选择「覆盖」换成 {preview.version || '新'} 版，或取消。</>
          ) : (
            <>标识 {preview.ref} 已被「{clash.displayName}」占用，原地址：
              <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}> {clash.url}</span>
              。请选择覆盖、改名安装或取消。</>
          )}
        </div>
      )}
      {preview.kind === 'skill' ? (
        <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
          <div style={label}>{preview.platform ? '来源：平台技能市场（企业管理员已安装并开放给成员）' : '来源：企业自建技能（企业管理员已开放给成员）'}</div>
          <div>技能：<strong style={{ color: 'var(--text-primary)' }}>{preview.displayName || preview.ref}</strong>（标识 {preview.ref}{preview.version ? `，版本 ${preview.version}` : ''}）</div>
          {preview.reason && <div>理由（模型填写）：{preview.reason}</div>}
        </div>
      ) : <>
      <div>
        <div style={label}>{preview.platform ? '来源：平台 MCP 目录（企业管理员已启用），服务地址：' : '服务地址（请确认主机名是你信任的）'}</div>
        <div data-testid="install-url" style={{ fontSize: 12, lineHeight: 1.6, fontFamily: 'monospace', wordBreak: 'break-all', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', color: 'var(--text-muted)' }}>
          {preview.before}<strong style={{ color: 'var(--text-primary)', fontSize: 13 }}>{preview.host}</strong>{preview.after}
        </div>
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
        <div style={label}>{preview.platform ? '名称来自平台目录；理由由模型填写' : '以下名称与理由由模型填写，未经核实'}</div>
        <div>名称：{preview.displayName || '—'}（标识 {preview.ref}）</div>
        {preview.reason && <div>理由：{preview.reason}</div>}
      </div>
      </>}
    </div>
  )
}

function signInFailure(error: McpLogin['error']): string {
  return signInFailureText(error, '安装没有完成，可以让员工稍后重试。')
}

/** 迟迟拿不到登录进度时，多久后检查是否其实已装好（本机已有该地址的有效登录），以及多久后放弃。 */
const SIGN_IN_CHECK_MS = 3_000
const SIGN_IN_GIVE_UP_MS = 15_000

/**
 * 等待浏览器登录的条目在后台轮询登录进度（即使弹窗正显示另一条审批）：
 * 完成 → 关闭；失败 → 保留并显示原因；本机凭据仍有效（Agent 直接装好，没有登录进度）→ 关闭。
 */
function SignInWatcher({ item, ref: capabilityRef, url }: { item: PendingApproval; ref: string; url: string }) {
  const setLogin = useApprovalStore((s) => s.setLogin)
  const failSignIn = useApprovalStore((s) => s.failSignIn)
  const dismiss = useApprovalStore((s) => s.dismiss)
  const { approvalId, conversationId } = item
  const since = item.signInSince ?? 0
  useEffect(() => {
    let stopped = false
    const tick = async () => {
      try {
        const login = await agentApi.getApprovalMcpLogin(conversationId, approvalId)
        if (stopped) return
        if (login) {
          setLogin(approvalId, login)
          if (login.status === 'completed') dismiss(approvalId)
          else if (login.status === 'failed') failSignIn(approvalId, signInFailure(login.error))
          return
        }
        const waited = Date.now() - since
        if (waited < SIGN_IN_CHECK_MS) return
        const installed = (await agentApi.listLocalCapabilities()).some((c) => c.kind === 'mcp' && c.ref === capabilityRef && c.url === url && c.auth_status === 'signed_in')
        if (stopped) return
        if (installed) dismiss(approvalId)
        else if (waited > SIGN_IN_GIVE_UP_MS) failSignIn(approvalId, '没有拿到服务方登录页，安装结果请看对话里员工的回复。')
      } catch { /* 暂时读不到本机 Agent：下一轮再读 */ }
    }
    void tick()
    const timer = setInterval(() => void tick(), 1500)
    return () => { stopped = true; clearInterval(timer) }
  }, [approvalId, conversationId, since, capabilityRef, url, setLogin, failSignIn, dismiss])
  return null
}

/** 等待登录：显示登录页地址（完整、可复制），可让本机 Agent 重新打开登录页，或取消登录。 */
function SignInBody({ item }: { item: PendingApproval }) {
  const dismiss = useApprovalStore((s) => s.dismiss)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const login = item.login
  if (item.errorMessage) {
    return (
      <>
        <div role="alert" style={{ padding: '0 20px', fontSize: 12, lineHeight: 1.6, color: '#ff6666' }}>{item.errorMessage}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 20px 18px' }}>
          <button type="button" onClick={() => dismiss(item.approvalId)} style={ghostBtnStyle}><X size={13} style={{ marginRight: 4 }} />关闭</button>
        </div>
      </>
    )
  }
  const act = async (run: () => Promise<string | null>) => {
    setBusy(true)
    try { setNote(await run()) } catch (error) { setNote(error instanceof Error ? error.message : '操作失败，请重试') } finally { setBusy(false) }
  }
  return (
    <>
      <div style={{ padding: '0 20px', display: 'grid', gap: 10, fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
        {login ? (
          <>
            <div>已在系统浏览器打开 <strong style={{ color: 'var(--text-primary)' }}>{login.auth_host}</strong> 的登录页。请在浏览器里登录并同意授权，完成后自动安装；令牌只保存在本机。</div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>浏览器没有打开？可以复制下面的链接到浏览器里打开（10 分钟内有效）：</div>
              <div data-testid="sign-in-url" style={{ fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all', maxHeight: 96, overflowY: 'auto', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', color: 'var(--text-muted)' }}>
                {login.authorization_url}
              </div>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={spinnerStyle('var(--border)', 'var(--brand)')} />正在准备服务方登录页…</div>
        )}
        {note && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{note}</div>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 10, padding: '12px 20px 18px' }}>
        <button
          type="button" disabled={!login || busy} style={{ ...ghostBtnStyle, opacity: !login || busy ? 0.5 : 1 }}
          onClick={() => login && void act(async () => { await agentApi.cancelMcpLogin(login.login_id); dismiss(item.approvalId); return null })}
        >取消登录</button>
        <button
          type="button" disabled={!login} style={{ ...ghostBtnStyle, opacity: login ? 1 : 0.5 }}
          onClick={() => login && void act(async () => { await navigator.clipboard.writeText(login.authorization_url); return '链接已复制。' })}
        >复制链接</button>
        <button
          type="button" disabled={!login || busy} style={{ ...primaryBtnStyle, opacity: !login || busy ? 0.6 : 1 }}
          onClick={() => login && void act(async () => (await agentApi.reopenMcpLogin(login.login_id)) ? '已在浏览器重新打开登录页。' : '这次登录已经结束。')}
        >在浏览器打开</button>
      </div>
    </>
  )
}

/** MCP 鉴权说明 / 令牌输入。令牌输入框不回显，只随本次决定交给本机 Agent。 */
function AuthSection({ preview, token, header, disabled, onToken, onHeader }: {
  preview: CapabilityInstallPreview
  token: string
  header: string
  disabled: boolean
  onToken: (value: string) => void
  onHeader: (value: string) => void
}) {
  if (preview.kind !== 'mcp' || preview.auth === 'none') return null
  const box: React.CSSProperties = { fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)', border: '1px solid color-mix(in srgb, #4488ff 35%, transparent)', borderRadius: 8, padding: '8px 12px', background: 'color-mix(in srgb, #4488ff 8%, var(--surface-2))' }
  if (preview.auth === 'oauth') {
    return (
      <div style={{ padding: '10px 20px 0' }}>
        <div style={box}>
          <LogIn size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />
          需要登录服务方账号{preview.authHost && <>（<strong style={{ color: 'var(--text-primary)' }}>{preview.authHost}</strong>）</>}。
          点「允许并登录」后用系统浏览器打开服务方登录页，登录完成后自动安装；令牌只保存在本机，不交给模型。
        </div>
      </div>
    )
  }
  return (
    <div style={{ padding: '10px 20px 0', display: 'grid', gap: 8 }}>
      <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
        <span><KeyRound size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />访问令牌（只交给本机 Agent，不进入对话、不交给模型）</span>
        <input
          type="password" autoComplete="off" spellCheck={false} aria-label="访问令牌"
          value={token} disabled={disabled} onChange={(event) => onToken(event.target.value)}
          style={inputStyle}
        />
      </label>
      {preview.authHeader ? (
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>令牌放在请求头 <code>{preview.authHeader}</code>{preview.platform ? '（平台目录指定）' : ''}。</div>
      ) : (
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
          请求头名（可选；不填则为 Authorization: Bearer）
          <input aria-label="请求头名" value={header} disabled={disabled} placeholder="例如 X-API-Key" onChange={(event) => onHeader(event.target.value)} style={inputStyle} />
        </label>
      )}
    </div>
  )
}

export default function ApprovalDialog() {
  const pending = useApprovalStore((s) => s.pending)
  const pruneExpired = useApprovalStore((s) => s.pruneExpired)
  const decide = useApprovalStore((s) => s.decide)
  const dismiss = useApprovalStore((s) => s.dismiss)
  // 仅用于每秒触发重渲染；剩余时间在渲染时取当前时刻，避免空闲期间 state 里的旧时间让首帧偏大
  const [, setTick] = useState(0)
  // 同名冲突时「改名安装」输入的新标识；null 表示未进入改名。换到下一条审批时清空。
  const [rename, setRename] = useState<string | null>(null)
  // 「以后从平台目录安装时直接安装」：只对平台目录来源出现，换到下一条审批时清空。
  const [remember, setRemember] = useState(false)
  // 「本会话不再询问该工具」：只对外部工具（MCP 连接器等）出现；会话删除后失效。
  const [sessionAllow, setSessionAllow] = useState(false)
  // 正在等浏览器登录的条目不挡住新来的审批（新审批有倒计时）。
  const item = pending.find((p) => p.phase !== 'signing_in') ?? pending[0]
  const currentId = item?.approvalId
  // 需要访问令牌的 MCP：令牌与可选请求头名。换到下一条审批、或提交失败（含令牌被拒）时清空。
  const [token, setToken] = useState('')
  const [header, setHeader] = useState('')
  useEffect(() => { setRename(null); setRemember(false); setSessionAllow(false); setToken(''); setHeader('') }, [currentId])
  useEffect(() => { if (item?.phase === 'error') setToken('') }, [item?.phase, currentId])

  useEffect(() => {
    if (pending.length === 0) return
    const timer = setInterval(() => { pruneExpired(); setTick((n) => n + 1) }, 1000)
    return () => clearInterval(timer)
  }, [pending.length, pruneExpired])

  if (!item) return null
  // 多条审批排队：处理完最旧的一条自动露出下一条，不展示队列数量
  const watchers = pending.filter((p) => p.phase === 'signing_in' && !p.errorMessage).map((p) => {
    const preview = parseCapabilityInstall(p.toolName, p.summary)
    return <SignInWatcher key={p.approvalId} item={p} ref={preview?.ref ?? ''} url={preview?.url ?? ''} />
  })
  const install = parseCapabilityInstall(item.toolName, item.summary)
  const meta = install
    ? install.kind === 'skill'
      ? { label: '安装个人能力（技能）', icon: BookOpen, tone: '#4488ff' }
      : { label: '安装个人能力（MCP）', icon: Globe, tone: '#4488ff' }
    : riskMeta[item.riskLevel] ?? riskMeta.unknown
  const Icon = meta.icon
  const remain = remainingSeconds(item, Date.now())
  const deciding = item.phase === 'deciding'
  const expired = item.phase === 'expired'
  const signingIn = item.phase === 'signing_in'
  const mcpAuth = install?.kind === 'mcp' ? install.auth : 'none'
  const needsToken = mcpAuth === 'bearer' && !token.trim()
  const tokenHeader = install?.authHeader || header.trim()
  const authOptions: DecideOptions = mcpAuth === 'bearer'
    ? { credential: { token: token.trim(), ...(tokenHeader ? { header: tokenHeader } : {}) } }
    : mcpAuth === 'oauth' ? { signIn: true } : {}

  return <>{watchers}{createPortal(
    <div style={overlayStyle} role="presentation">
      <style>{`
        @keyframes approvalIn { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: none; } }
        @keyframes approvalSpin { to { transform: rotate(360deg); } }
      `}</style>
      <div role="alertdialog" aria-modal="true" aria-label="工具权限审批" style={dialogStyle}>
        {/* 头部 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px 14px' }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            display: 'grid', placeItems: 'center',
            background: `color-mix(in srgb, ${meta.tone} 14%, var(--surface-2))`,
            border: `1px solid color-mix(in srgb, ${meta.tone} 40%, transparent)`,
            color: meta.tone,
          }}>
            {expired ? <ShieldAlert size={20} /> : <Icon size={20} />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              {expired ? '审批已失效' : signingIn ? '登录服务方账号' : item.employee ? `${item.employee} 请求权限` : '工具权限请求'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {meta.label} · <code style={{ fontSize: 11 }}>{item.toolName}</code>
            </div>
          </div>
          {!expired && !signingIn && remain !== null && <CountdownRing remain={remain} total={Math.ceil((item.totalMs ?? remain * 1000) / 1000)} tone={meta.tone} />}
        </div>

        {signingIn ? <SignInBody item={item} /> : <>
        {/* 参数预览 */}
        {install && <InstallPreview preview={install} />}
        {install && <AuthSection preview={install} token={token} header={header} disabled={deciding} onToken={setToken} onHeader={setHeader} />}
        {!install && item.summary && (
          <div style={{ padding: '0 20px' }}>
            <div style={{
              fontSize: 11, lineHeight: 1.6, color: 'var(--text-secondary)', fontFamily: 'monospace',
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '10px 12px',
              maxHeight: 120, overflowY: 'auto', wordBreak: 'break-all', whiteSpace: 'pre-wrap',
            }}>
              {item.summary}
            </div>
          </div>
        )}

        {install?.platform && !expired && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '12px 20px 0', fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)', cursor: deciding ? 'default' : 'pointer' }}>
            <input
              type="checkbox"
              checked={remember}
              disabled={deciding}
              onChange={(event) => setRemember(event.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>
              以后从平台目录安装{install.kind === 'skill' ? '技能' : ' MCP'}时直接安装，不再询问
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)' }}>只对平台目录来源生效；可在「设置 · 个人能力」撤销。</span>
            </span>
          </label>
        )}

        {/* 外部工具（MCP 连接器等）与技能安装：本会话内不再询问。会话级，删除会话即失效。
            MCP 安装不给出该选项：审批弹窗还要收集 OAuth 登录 / 访问令牌。 */}
        {(item.riskLevel === 'external' || install?.kind === 'skill') && !expired && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '12px 20px 0', fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)', cursor: deciding ? 'default' : 'pointer' }}>
            <input
              type="checkbox"
              checked={sessionAllow}
              disabled={deciding}
              onChange={(event) => setSessionAllow(event.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>
              {install?.kind === 'skill' ? '本会话内不再询问安装技能' : '本会话内不再询问该工具'}
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)' }}>只对当前会话生效；删除会话后恢复为每次询问。</span>
            </span>
          </label>
        )}

        {/* 错误提示（倒计时在头部右上角圆环） */}
        {item.errorMessage && (
          <div style={{ padding: '10px 20px 0', fontSize: 11, color: '#ff6666' }}>
            {item.errorMessage}
          </div>
        )}

        {/* 操作区：按钮文案恒定，提交中仅用 spinner 表达 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '12px 20px 18px' }}>
          {expired ? (
            <button type="button" onClick={() => dismiss(item.approvalId)} style={ghostBtnStyle}>
              <X size={13} style={{ marginRight: 4 }} />关闭
            </button>
          ) : install?.replaces ? (
            <ClashActions
              preview={install}
              deciding={deciding}
              rename={rename}
              onRename={setRename}
              onCancel={() => void decide(item.approvalId, 'deny')}
              blocked={needsToken}
              onReplace={() => void decide(item.approvalId, 'approve', { ...authOptions, resolution: { action: 'replace' }, remember: install.platform && remember, sessionAllow })}
              onRenameSubmit={(ref) => void decide(item.approvalId, 'approve', { ...authOptions, resolution: { action: 'rename', ref }, remember: install.platform && remember, sessionAllow })}
            />
          ) : (
            <>
              <button
                type="button"
                disabled={deciding}
                onClick={() => void decide(item.approvalId, 'deny')}
                style={{ ...ghostBtnStyle, opacity: deciding ? 0.5 : 1 }}
              >
                拒绝
              </button>
              <button
                type="button"
                disabled={deciding || needsToken}
                title={needsToken ? '请先填写访问令牌' : undefined}
                onClick={() => void decide(item.approvalId, 'approve', { ...authOptions, remember: Boolean(install?.platform) && remember, sessionAllow })}
                style={{ ...primaryBtnStyle, opacity: deciding ? 0.75 : needsToken ? 0.5 : 1 }}
              >
                {deciding && (
                  <span style={{
                    width: 12, height: 12, marginRight: 6, borderRadius: '50%',
                    border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#fff',
                    animation: 'approvalSpin 0.8s linear infinite',
                  }} />
                )}
                {mcpAuth === 'oauth' ? '允许并登录' : '允许'}
              </button>
            </>
          )}
        </div>
        </>}
      </div>
    </div>,
    document.body,
  )}</>
}

/** 同名冲突：取消 / 改名安装（仅 MCP）/ 覆盖。没有「允许」按钮，避免默认覆盖。 */
function ClashActions({ preview, deciding, blocked, rename, onRename, onCancel, onReplace, onRenameSubmit }: {
  preview: CapabilityInstallPreview
  deciding: boolean
  /** 需要访问令牌但还没填：覆盖 / 改名安装不可点。 */
  blocked: boolean
  rename: string | null
  onRename: (value: string | null) => void
  onCancel: () => void
  onReplace: () => void
  onRenameSubmit: (ref: string) => void
}) {
  const dim = (style: React.CSSProperties) => ({ ...style, opacity: deciding ? 0.5 : 1 })
  if (rename !== null) {
    const problem = renameProblem(rename, preview.ref)
    return (
      <div style={{ display: 'grid', gap: 8, width: '100%' }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
          新的标识（原有的「{preview.replaces?.displayName}」保留不动）
          <input
            autoFocus
            value={rename}
            disabled={deciding}
            aria-invalid={Boolean(problem)}
            onChange={(event) => onRename(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !problem) onRenameSubmit(rename.trim()) }}
            style={{ fontSize: 13, fontFamily: 'monospace', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-primary)' }}
          />
        </label>
        {problem && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{problem}</span>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" disabled={deciding} onClick={() => onRename(null)} style={dim(ghostBtnStyle)}>返回</button>
          <button type="button" disabled={deciding || blocked || Boolean(problem)} onClick={() => onRenameSubmit(rename.trim())} style={{ ...primaryBtnStyle, opacity: deciding || blocked || problem ? 0.6 : 1 }}>改名安装</button>
        </div>
      </div>
    )
  }
  return (
    <>
      <button type="button" disabled={deciding} onClick={onCancel} style={dim(ghostBtnStyle)}>取消安装</button>
      {preview.kind === 'mcp' && (
        <button type="button" disabled={deciding} onClick={() => onRename(`${preview.ref}-2`.slice(0, 64))} style={dim(ghostBtnStyle)}>改名安装</button>
      )}
      <button type="button" disabled={deciding || blocked} onClick={onReplace} style={{ ...primaryBtnStyle, opacity: deciding ? 0.75 : blocked ? 0.5 : 1 }}>覆盖</button>
    </>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 10000,
  background: 'var(--overlay-bg, rgba(10,10,15,0.62))',
  backdropFilter: 'blur(2px)',
  display: 'grid', placeItems: 'center',
}

const dialogStyle: React.CSSProperties = {
  width: 420, maxWidth: 'calc(100vw - 48px)',
  // 令牌输入 / 登录链接让内容变高：小窗口下弹窗内部滚动，按钮始终可达。
  maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
  background: 'var(--surface-1)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  boxShadow: '0 24px 64px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.25)',
  animation: 'approvalIn 0.18s ease-out',
}

const primaryBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center',
  fontSize: 13, fontWeight: 600, padding: '7px 22px', borderRadius: 8,
  border: 'none', cursor: 'pointer',
  background: 'var(--brand)', color: '#fff',
}

const ghostBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center',
  fontSize: 13, padding: '7px 18px', borderRadius: 8,
  border: '1px solid var(--border)', cursor: 'pointer',
  background: 'var(--surface-2)', color: 'var(--text-primary)',
}

const inputStyle: React.CSSProperties = {
  fontSize: 13, fontFamily: 'monospace', padding: '7px 10px', borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-primary)',
}

function spinnerStyle(track: string, head: string): React.CSSProperties {
  return { width: 12, height: 12, borderRadius: '50%', border: `2px solid ${track}`, borderTopColor: head, animation: 'approvalSpin 0.8s linear infinite', flexShrink: 0 }
}
