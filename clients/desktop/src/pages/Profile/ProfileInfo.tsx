import { Building2, LockKeyhole } from 'lucide-react'
import { useAgentAuthStore } from '../../stores/agentAuth'

export default function ProfileInfo() {
  const account = useAgentAuthStore((state) => state.account)
  const memberId = useAgentAuthStore((state) => state.claims?.user_id ?? null)
  const tenantId = useAgentAuthStore((state) => state.tenantId)
  const avatarLetter = (account || '用').slice(0, 1).toUpperCase()

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto max-w-[600px]">
        <div className="mb-8 flex flex-col items-center">
          <div
            className="flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-3xl font-bold text-txt-inverse shadow-lg"
            role="img"
            aria-label="当前账号默认头像"
          >
            {avatarLetter}
          </div>
          <p className="mt-3 text-[12px] text-txt-muted">当前使用账号首字母作为默认头像</p>
        </div>

        <section className="rounded-[14px] border border-[var(--border)] bg-surface-2/50 p-5" aria-labelledby="profile-identity-title">
          <div className="mb-5 flex items-start gap-3">
            <LockKeyhole className="mt-0.5 shrink-0 text-brand" size={18} strokeWidth={1.8} aria-hidden="true" />
            <div>
              <h2 id="profile-identity-title" className="text-[14px] font-semibold text-txt-primary">账号身份（只读）</h2>
              <p className="mt-1 text-[12px] leading-5 text-txt-secondary">
                当前客户端仅展示登录会话中的身份信息，不提供资料编辑、头像上传或个人简介保存。
              </p>
            </div>
          </div>

          <dl className="space-y-4">
            <div>
              <dt className="mb-1.5 text-[12px] font-medium text-txt-secondary">登录账号</dt>
              <dd className="flex min-h-10 items-center rounded-[10px] border border-[var(--border)] bg-surface-2 px-3 text-[14px] text-txt-primary">
                {account ?? '-'}
              </dd>
            </div>
            <div>
              <dt className="mb-1.5 text-[12px] font-medium text-txt-secondary">成员 ID</dt>
              <dd className="flex min-h-10 items-center break-all rounded-[10px] border border-[var(--border)] bg-surface-2 px-3 text-[14px] text-txt-muted">
                {memberId ?? '-'}
              </dd>
            </div>
            <div>
              <dt className="mb-1.5 text-[12px] font-medium text-txt-secondary">企业租户 ID</dt>
              <dd className="flex min-h-10 items-center break-all rounded-[10px] border border-[var(--border)] bg-surface-2 px-3 text-[14px] text-txt-muted">
                {tenantId ?? '-'}
              </dd>
            </div>
          </dl>
        </section>

        <div className="mt-4 flex gap-3 rounded-[12px] border border-[var(--border)] bg-surface-2/30 p-4 text-[12px] leading-5 text-txt-secondary">
          <Building2 className="mt-0.5 shrink-0 text-txt-muted" size={17} strokeWidth={1.7} aria-hidden="true" />
          <p>显示名称等成员资料由企业管理员在管理端维护；当前服务尚未开放个人头像上传契约。</p>
        </div>
      </div>
    </div>
  )
}
