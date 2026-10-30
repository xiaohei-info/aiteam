/**
 * 登录页：企业标识 选填，留空时先通过账号解析所属企业。
 * POST /api/agent/login { enterprise, account, password } → { token, claims }
 *
 * @注意 403 forbidden + reset-required detail → 切换强制改密;其他错误按状态分流。
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ArrowLeft, Building2, Eye, EyeOff, LockKeyhole, ShieldCheck, Sparkles, User } from 'lucide-react'
import { useAgentAuthStore } from '../../stores/agentAuth'
import { AgentApiError } from '../../api/agent'
import { readAuthDiagnostics } from '../../lib/authDiagnostics'
import { SessionPersistenceError } from '../../lib/authSession'
import { loginUnavailableMessage } from '../../lib/loginServiceError'
import {
  deleteSavedLoginCredentials,
  listSavedLoginCredentialProfiles,
  matchSavedCredentialProfile,
  readSavedLoginCredentials,
  saveLoginCredentials,
  type SavedCredentialProfileSummary,
} from '../../lib/loginCredentials'

export default function Login() {
  const [enterprise, setEnterprise] = useState('')
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [savedProfiles, setSavedProfiles] = useState<SavedCredentialProfileSummary[]>([])
  const [rememberCredentials, setRememberCredentials] = useState(true)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const login = useAgentAuthStore((s) => s.login)
  const resetPassword = useAgentAuthStore((s) => s.resetPassword)
  const cancelPasswordReset = useAgentAuthStore((s) => s.cancelPasswordReset)
  const pendingPasswordReset = useAgentAuthStore((s) => s.pendingPasswordReset)
  const restoreError = useAgentAuthStore((s) => s.restoreError)
  const restoreSession = useAgentAuthStore((s) => s.restoreSession)
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      readSavedLoginCredentials(),
      listSavedLoginCredentialProfiles(),
    ])
      .then(([saved, profiles]) => {
        if (cancelled) return
        setSavedProfiles(profiles)
        if (!saved) return
        setEnterprise(saved.enterprise)
        setAccount(saved.account)
        setPassword(saved.password)
      })
      .catch((loadError) => {
        console.error('[Login] failed to read saved credentials:', loadError)
      })
    return () => { cancelled = true }
  }, [])

  const syncSavedPasswordForIdentity = (nextEnterprise: string, nextAccount: string) => {
    const matched = matchSavedCredentialProfile(savedProfiles, nextEnterprise, nextAccount)
    if (!matched || !nextAccount.trim()) return
    void readSavedLoginCredentials({
      enterprise: nextEnterprise.trim() || matched.enterprise,
      account: matched.account,
    })
      .then((saved) => {
        if (!saved) return
        setPassword(saved.password)
        if (!nextEnterprise.trim() && saved.enterprise) {
          setEnterprise(saved.enterprise)
        }
      })
      .catch(() => {})
  }

  const handleSelectSavedProfile = (profile: SavedCredentialProfileSummary) => {
    setEnterprise(profile.enterprise)
    setAccount(profile.account)
    void readSavedLoginCredentials({
      enterprise: profile.enterprise,
      account: profile.account,
    })
      .then((saved) => {
        if (!saved) return
        setEnterprise(saved.enterprise)
        setAccount(saved.account)
        setPassword(saved.password)
      })
      .catch(() => {})
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if ((!pendingPasswordReset && !account.trim()) || !password) return
    if (pendingPasswordReset) {
      if (!newPassword || !confirmPassword) {
        setError('请填写并确认新密码')
        return
      }
      if (newPassword !== confirmPassword) {
        setError('两次输入的新密码不一致')
        return
      }
    }
    setIsLoading(true)
    setError(null)
    try {
      const loginEnterprise = (pendingPasswordReset?.enterprise ?? pendingPasswordReset?.tenant_id ?? enterprise).trim()
      const loginAccount = (pendingPasswordReset?.account ?? account).trim()
      let loginPassword = password
      if (pendingPasswordReset) {
        await resetPassword(password, newPassword)
        loginPassword = newPassword
      } else {
        const outcome = await login(enterprise.trim(), account.trim(), password)
        if (outcome === 'password_reset_required') {
          setNewPassword('')
          setConfirmPassword('')
          setShowPassword(false)
          setShowNewPassword(false)
          setShowConfirmPassword(false)
          return
        }
      }
      try {
        if (rememberCredentials) {
          await saveLoginCredentials({ enterprise: loginEnterprise, account: loginAccount, password: loginPassword })
        } else {
          await deleteSavedLoginCredentials({ enterprise: loginEnterprise, account: loginAccount })
        }
      } catch (credentialError) {
        console.error('[Login] failed to save remembered credentials:', credentialError)
        setError('登录成功，但登录信息未能保存，请下次手动输入')
      }
      setPassword('')
      setNewPassword('')
      setConfirmPassword('')
      navigate('/chat')
    } catch (err) {
      if (err instanceof SessionPersistenceError) {
        setError(err.message)
      } else if (err instanceof AgentApiError) {
        const problemCode = err.problem?.code ?? err.code
        const problemDetail = err.problem?.detail ?? ''
        if (err.status === 401) {
          setError(pendingPasswordReset ? '当前密码不正确，请重新输入' : '企业标识、账号或密码错误，请重试')
        } else if (err.status === 403) {
          setError('当前账号无法完成此操作，请联系管理员')
        } else if (err.status === 404) {
          setError('账号不存在或所属企业未开通,请联系管理员')
        } else if (
          err.status === 422
          && problemCode === 'validation_error'
          && /password policy violation/i.test(problemDetail)
        ) {
          setError('新密码不符合企业密码策略（长度、大小写字母、数字和符号）')
        } else if (err.status === 422) {
          setError('提交的信息不符合要求，请检查后重试')
        } else if (err.status === 503) {
          setError(loginUnavailableMessage(problemDetail))
        } else if (err.status >= 500) {
          setError('后端服务异常,请稍后重试')
        } else {
          setError(err.problem?.detail ?? err.message ?? '登录失败')
        }
      } else {
        // 非 AgentApiError:通常是 fetch 层异常(相对路径 + tauri http、CORS、DNS、断网)。
        setError('网络异常,请检查连接或稍后重试')
      }
    } finally {
      setIsLoading(false)
    }
  }

  const handleCancelPasswordReset = () => {
    cancelPasswordReset()
    setPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setShowPassword(false)
    setShowNewPassword(false)
    setShowConfirmPassword(false)
    setError(null)
  }

  const handleRestoreSession = async () => {
    await restoreSession()
    if (useAgentAuthStore.getState().isAuthenticated) navigate('/chat', { replace: true })
  }

  return (
    <div
      data-tauri-drag-region
      className="app-page-bg relative flex h-[100dvh] items-center justify-center overflow-hidden"
    >
      <div data-tauri-drag-region className="absolute inset-0 grain" />

      <header
        data-tauri-drag-region
        className="absolute inset-x-0 top-0 z-20 flex h-12 items-center px-4"
        aria-label="窗口控制栏"
      >
        <div className="flex items-center gap-[7px]">
          <button
            type="button"
            onClick={() => getCurrentWindow().close()}
            className="h-[12px] w-[12px] flex-shrink-0 cursor-pointer rounded-full border border-[#e0443e]/40 bg-[#ff5f57] shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors duration-150 hover:bg-[#ff3b30]"
            title="关闭"
            aria-label="关闭窗口"
          />
          <button
            type="button"
            onClick={() => getCurrentWindow().minimize()}
            className="h-[12px] w-[12px] flex-shrink-0 cursor-pointer rounded-full border border-[#dea123]/40 bg-[#febc2e] shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors duration-150 hover:bg-[#f5a623]"
            title="最小化"
            aria-label="最小化窗口"
          />
          <button
            type="button"
            onClick={() => getCurrentWindow().toggleMaximize()}
            className="h-[12px] w-[12px] flex-shrink-0 cursor-pointer rounded-full border border-[#1aab29]/40 bg-[#28c840] shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors duration-150 hover:bg-[#1db934]"
            title="最大化 / 还原"
            aria-label="切换窗口最大化"
          />
        </div>
      </header>

      <form
        onSubmit={handleSubmit}
        className="glass-panel relative z-10 max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-[380px] overflow-y-auto animate-fade-up rounded-[20px] p-9"
      >
        <div className="mb-9 flex flex-col items-center">
          <div className="relative mb-5">
            <div className="gold-gradient glow-gold flex h-16 w-16 items-center justify-center rounded-[18px] text-txt-inverse shadow-2xl shadow-brand/25">
              <Sparkles size={26} strokeWidth={1.6} />
            </div>
            <div className="absolute -inset-2 rounded-[22px] border border-brand/10 animate-pulse-warm" />
          </div>
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-txt-primary">
            {pendingPasswordReset ? '设置新密码' : 'AIFred'}
          </h1>
          <p className="mt-1.5 text-center text-[13px] text-txt-secondary">
            {pendingPasswordReset
              ? '当前密码为临时或已过期密码，修改后即可进入工作台'
              : 'AI 原生组织工作台'}
          </p>
        </div>

        <details className="mb-4 text-xs text-txt-secondary">
          <summary className="cursor-pointer">登录状态诊断记录</summary>
          <p className="my-2">最近 100 条记录，仅含时间、退出原因、来源、状态码与凭证剩余有效期，不含账号或凭证。可选中复制用于排查。</p>
          <textarea readOnly aria-label="登录状态诊断日志" className="w-full h-32 rounded-lg bg-surface-0 p-3" value={readAuthDiagnostics().map(item => JSON.stringify(item)).join('\n') || '暂无记录'} />
        </details>
        <div className="space-y-3.5">
          {!pendingPasswordReset && savedProfiles.length > 1 && (
            <div className="rounded-[12px] border border-[var(--border)] bg-surface-0/70 px-3 py-2">
              <div className="mb-1.5 text-[11px] text-txt-muted">已保存账号（按企业与账号加密存储）</div>
              <div className="flex flex-wrap gap-1.5">
                {savedProfiles.map((profile) => {
                  const key = `${profile.enterprise}::${profile.account}`
                  const isCurrent =
                    profile.account.toLowerCase() === account.trim().toLowerCase()
                    && profile.enterprise.toLowerCase() === enterprise.trim().toLowerCase()
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleSelectSavedProfile(profile)}
                      className={`rounded-lg border px-2.5 py-1 text-[11px] transition-colors ${
                        isCurrent
                          ? 'border-brand/40 bg-brand/15 text-brand'
                          : 'border-[var(--border)] bg-surface-1 text-txt-secondary hover:border-brand/25 hover:text-txt-primary'
                      }`}
                    >
                      {profile.enterprise ? `${profile.enterprise} · ${profile.account}` : profile.account}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div className="group">
            <div className="relative">
              <Building2 size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-txt-muted transition-colors group-focus-within:text-brand/70" />
              <input
                type="text"
                name="enterprise"
                aria-label="企业标识"
                aria-describedby="tenant-id-hint"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="企业标识（选填）"
                value={pendingPasswordReset?.enterprise ?? pendingPasswordReset?.tenant_id ?? enterprise}
                onChange={(e) => {
                  const nextEnterprise = e.target.value
                  setEnterprise(nextEnterprise)
                  syncSavedPasswordForIdentity(nextEnterprise, account)
                }}
                disabled={Boolean(pendingPasswordReset)}
                className="w-full rounded-[14px] border border-[var(--border)] bg-surface-0 py-3.5 pl-11 pr-4 text-[13px] text-txt-primary placeholder:text-txt-muted transition-all duration-200 focus:border-brand/25 focus:bg-surface-1"
              />
            </div>
            <p id="tenant-id-hint" className="mt-1.5 px-1 text-[12px] text-txt-secondary">
              {pendingPasswordReset ? '修改密码将使用此企业标识' : '填写企业代码或名称；留空自动识别所属企业'}
            </p>
          </div>
          <div className="group">
            <div className="relative">
              <User size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-txt-muted transition-colors group-focus-within:text-brand/70" />
              <input
                type="text"
                autoComplete="username"
                placeholder="账号 / 手机号"
                value={pendingPasswordReset?.account ?? account}
                onChange={(e) => {
                  const nextAccount = e.target.value
                  setAccount(nextAccount)
                  syncSavedPasswordForIdentity(enterprise, nextAccount)
                }}
                disabled={Boolean(pendingPasswordReset)}
                className="w-full rounded-[14px] border border-[var(--border)] bg-surface-0 py-3.5 pl-11 pr-4 text-[13px] text-txt-primary placeholder:text-txt-muted transition-all duration-200 focus:border-brand/25 focus:bg-surface-1"
              />
            </div>
          </div>
          {!pendingPasswordReset && (
            <label className="flex items-center gap-2 px-1 text-[12px] text-txt-secondary">
              <input
                type="checkbox"
                checked={rememberCredentials}
                onChange={(e) => setRememberCredentials(e.target.checked)}
                className="accent-brand"
              />
              记住账号和密码
            </label>
          )}
          <div className="group">
            <div className="relative">
              <LockKeyhole size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-txt-muted transition-colors group-focus-within:text-brand/70" />
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                autoCapitalize="none"
                spellCheck={false}
                placeholder={pendingPasswordReset ? '当前密码' : '密码'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-[14px] border border-[var(--border)] bg-surface-0 py-3.5 pl-11 pr-12 text-[13px] text-txt-primary placeholder:text-txt-muted transition-all duration-200 focus:border-brand/25 focus:bg-surface-1"
              />
              <button
                type="button"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                title={showPassword ? '隐藏密码' : '显示密码'}
                onClick={() => setShowPassword((visible) => !visible)}
                className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-txt-muted transition-colors hover:text-brand"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          {pendingPasswordReset && (
            <>
              <div className="group">
                <div className="relative">
                  <ShieldCheck size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-txt-muted transition-colors group-focus-within:text-brand/70" />
                  <input
                    type={showNewPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="新密码"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full rounded-[14px] border border-[var(--border)] bg-surface-0 py-3.5 pl-11 pr-12 text-[13px] text-txt-primary placeholder:text-txt-muted transition-all duration-200 focus:border-brand/25 focus:bg-surface-1"
                  />
                  <button
                    type="button"
                    aria-label={showNewPassword ? '隐藏新密码' : '显示新密码'}
                    title={showNewPassword ? '隐藏新密码' : '显示新密码'}
                    onClick={() => setShowNewPassword((visible) => !visible)}
                    className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-txt-muted transition-colors hover:text-brand"
                  >
                    {showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <div className="group">
                <div className="relative">
                  <ShieldCheck size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-txt-muted transition-colors group-focus-within:text-brand/70" />
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="确认新密码"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full rounded-[14px] border border-[var(--border)] bg-surface-0 py-3.5 pl-11 pr-12 text-[13px] text-txt-primary placeholder:text-txt-muted transition-all duration-200 focus:border-brand/25 focus:bg-surface-1"
                  />
                  <button
                    type="button"
                    aria-label={showConfirmPassword ? '隐藏确认密码' : '显示确认密码'}
                    title={showConfirmPassword ? '隐藏确认密码' : '显示确认密码'}
                    onClick={() => setShowConfirmPassword((visible) => !visible)}
                    className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-txt-muted transition-colors hover:text-brand"
                  >
                    {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {restoreError && !pendingPasswordReset && (
          <div role="alert" className="mt-4 rounded-[10px] border border-brand/20 bg-brand/[0.06] px-4 py-2.5 text-[12px] text-txt-secondary">
            <p>{restoreError}</p>
            <button type="button" disabled={isLoading} onClick={handleRestoreSession} className="mt-2 text-brand underline disabled:opacity-50">
              重试恢复登录
            </button>
          </div>
        )}

        {error && (
          <div role="alert" className="mt-4 rounded-[10px] border border-danger/20 bg-danger/[0.06] px-4 py-2.5 text-[12px] text-danger/90">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={isLoading}
          className="group relative mt-7 w-full overflow-hidden rounded-[14px] bg-gradient-to-r from-brand-500 to-brand-400 py-3.5 font-display text-[14px] font-semibold text-txt-inverse shadow-xl shadow-brand/15 transition-all duration-300 hover:shadow-2xl hover:shadow-brand/25 hover:brightness-110 disabled:opacity-50 disabled:pointer-events-none"
        >
          <span className="relative z-10">
            {isLoading ? (
              <span className="inline-flex items-center gap-2.5">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-[rgba(10,10,15,0.25)] border-t-[var(--text-on-brand)]" />
                {pendingPasswordReset ? '正在修改' : '正在登录'}
              </span>
            ) : pendingPasswordReset ? '修改密码并登录' : '登  录'}
          </span>
          <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity animate-shimmer" />
        </button>

        {pendingPasswordReset && (
          <button
            type="button"
            onClick={handleCancelPasswordReset}
            disabled={isLoading}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[10px] py-2 text-[12px] text-txt-secondary transition-colors hover:text-txt-primary disabled:pointer-events-none disabled:opacity-50"
          >
            <ArrowLeft size={14} />
            返回账号登录
          </button>
        )}
      </form>
    </div>
  )
}
