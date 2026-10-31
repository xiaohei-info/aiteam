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
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ShieldAlert, Terminal, FilePenLine, FilePlus2, Globe, Wrench, X } from 'lucide-react'
import { useApprovalStore, type PendingApproval } from '../../stores/approvals'

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

export default function ApprovalDialog() {
  const pending = useApprovalStore((s) => s.pending)
  const pruneExpired = useApprovalStore((s) => s.pruneExpired)
  const decide = useApprovalStore((s) => s.decide)
  const dismiss = useApprovalStore((s) => s.dismiss)
  // 仅用于每秒触发重渲染；剩余时间在渲染时取当前时刻，避免空闲期间 state 里的旧时间让首帧偏大
  const [, setTick] = useState(0)

  useEffect(() => {
    if (pending.length === 0) return
    const timer = setInterval(() => { pruneExpired(); setTick((n) => n + 1) }, 1000)
    return () => clearInterval(timer)
  }, [pending.length, pruneExpired])

  if (pending.length === 0) return null
  // 多条审批排队：处理完最旧的一条自动露出下一条，不展示队列数量
  const item = pending[0]
  const meta = riskMeta[item.riskLevel] ?? riskMeta.unknown
  const Icon = meta.icon
  const remain = remainingSeconds(item, Date.now())
  const deciding = item.phase === 'deciding'
  const expired = item.phase === 'expired'

  return createPortal(
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
              {expired ? '审批已失效' : item.employee ? `${item.employee} 请求权限` : '工具权限请求'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {meta.label} · <code style={{ fontSize: 11 }}>{item.toolName}</code>
            </div>
          </div>
          {!expired && remain !== null && <CountdownRing remain={remain} total={Math.ceil((item.totalMs ?? remain * 1000) / 1000)} tone={meta.tone} />}
        </div>

        {/* 参数预览 */}
        {item.summary && (
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
                disabled={deciding}
                onClick={() => void decide(item.approvalId, 'approve')}
                style={{ ...primaryBtnStyle, opacity: deciding ? 0.75 : 1 }}
              >
                {deciding && (
                  <span style={{
                    width: 12, height: 12, marginRight: 6, borderRadius: '50%',
                    border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#fff',
                    animation: 'approvalSpin 0.8s linear infinite',
                  }} />
                )}
                允许
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
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
