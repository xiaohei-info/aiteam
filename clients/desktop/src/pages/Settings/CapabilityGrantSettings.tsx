import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, LoaderCircle, ShieldCheck, Trash2 } from 'lucide-react'
import { agentApi, AgentApiError } from '../../api/agent'
import type { CapabilityGrant } from '../../api/agent/types'
import { capabilityGrantSourceLabel, groupCapabilityGrants } from '../../lib/capabilityGrantLabels'
import '../../components/FileAccess/FileAccess.css'

export default function CapabilityGrantSettings() {
  const [grants, setGrants] = useState<CapabilityGrant[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      setGrants(await agentApi.listCapabilityGrants())
      setError('')
    } catch (err) {
      setError(err instanceof AgentApiError ? err.message : '能力授权读取失败，请稍后重试。')
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const revoke = async (grant: CapabilityGrant) => {
    const id = `${grant.conversation_id}:${grant.kind}:${grant.ref}`
    setBusyId(id)
    setError('')
    try {
      await agentApi.revokeCapabilityGrants(grant.conversation_id)
      // 一次撤销是整会话的，移除该会话的全部条目。
      setGrants(current => (current ?? []).filter(item => item.conversation_id !== grant.conversation_id))
    } catch (err) {
      setError(err instanceof AgentApiError ? err.message : '撤销失败，请重试。')
    } finally {
      setBusyId(null)
    }
  }

  const grouped = groupCapabilityGrants(grants ?? [])

  return <section id="capability-grants" className="settings-card glass-panel" aria-labelledby="settings-capability-grants-title">
    <div className="settings-section-heading">
      <ShieldCheck size={16} strokeWidth={1.7} aria-hidden="true" />
      <div>
        <h2 id="settings-capability-grants-title">能力授权</h2>
        <p>批准安装过的能力会在这里留下授权，<strong>仅本会话有效</strong>。平台预登记的 MCP 应用密钥只向已登记授权的本机会话下发；撤销后不再下发，已装能力不受影响。<br /><span className="capability-grant-meta">注：这里的授权是本机 Agent 上报的，Manager 只校验租户一致，不核对能力是否真的已安装；真正的约束仍是企业已启用该 MCP 且成员在职。</span></p>
      </div>
    </div>
    {grants === null
      ? <p className="file-access-note" role="status"><LoaderCircle className="file-access-spinner" size={14} aria-hidden="true" />正在读取能力授权…</p>
      : grouped.size === 0
        ? <div className="file-access-empty">
          <ShieldCheck size={20} strokeWidth={1.5} aria-hidden="true" />
          <div><strong>暂无能力授权</strong><p>在对话里批准安装 MCP 或技能后，授权会出现在这里。</p></div>
        </div>
        : <ul className="file-access-grants" aria-label="能力授权清单">
          {[...grouped.entries()].map(([conversationId, items]) => <li key={conversationId}>
            <span className="file-access-directory-icon"><ShieldCheck size={17} strokeWidth={1.7} aria-hidden="true" /></span>
            <span className="file-access-directory-path">
              <strong>{items.map(item => item.ref).join('、')}</strong>
              <span className="capability-grant-meta">
                会话 {conversationId.slice(0, 8)} · {items.map(item => `${item.kind === 'mcp' ? 'MCP' : '技能'} ${capabilityGrantSourceLabel(item.source)}`).join('；')}
              </span>
            </span>
            <button type="button" className="file-access-revoke" disabled={busyId !== null}
              aria-label={`撤销会话 ${conversationId} 的能力授权`}
              onClick={() => { void revoke(items[0]!) }}>
              <Trash2 size={13} aria-hidden="true" />{busyId === `${conversationId}:${items[0]!.kind}:${items[0]!.ref}` ? '撤销中…' : '撤销'}
            </button>
          </li>)}
        </ul>}
    {error && <p className="file-access-note" role="alert"><AlertCircle size={14} aria-hidden="true" />{error}</p>}
  </section>
}
