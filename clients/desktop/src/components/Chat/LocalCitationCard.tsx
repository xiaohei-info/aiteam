import { useState } from 'react'
import { FileSearch, FolderSearch, LoaderCircle, ShieldCheck, ShieldAlert, BookOpenText } from 'lucide-react'
import './LocalCitationCard.css'
import { agentApi, AgentApiError } from '../../api/agent'
import type { LocalDirectoryCitation } from '../../api/agent'
import type { LocalCitationHit } from '../../lib/localDirectoryCitations'

interface LocalCitationCardProps {
  hits: LocalCitationHit[]
  /** 所属回复是否仍在流式输出；输出中禁用原文预览，避免与在途引用竞争。 */
  isActive?: boolean
}

type VerifyState =
  | { phase: 'idle' }
  | { phase: 'loading'; citationId: string }
  | { phase: 'ready'; citation: LocalDirectoryCitation }
  | { phase: 'error'; citationId: string; message: string }

function errorText(error: unknown): string {
  if (error instanceof AgentApiError) {
    if (error.status === 404) return '引用已失效（单轮有效或已过期）。请让员工重新检索后再试。'
    if (error.status === 403) return '当前身份已无权查看该引用（授权可能在检索后被撤销）。'
    if (error.status === 409) return '源文件在检索后发生了变化，请让员工重新检索。'
    if (error.status === 503) return '桌面授权桥接暂不可用，请稍后重试。'
  }
  return error instanceof Error && error.message ? error.message : '引用校验失败'
}

/**
 * 用户消息上的标记：本机网关在发送前从授权目录检索（search）或列出目录（list），
 * 并把结果附在这条消息里交给员工。附加内容本身不在气泡中展示。
 */
export function LocalContextChip({ action }: { action: 'search' | 'list' }) {
  return (
    <span className="lcc-context-chip" title="内容来自你授权给当前员工的本机目录，只包含命中的片段或文件名">
      <FolderSearch size={12} aria-hidden="true" />
      {action === 'list' ? '已附带授权目录的文件清单' : '已附带授权目录的检索结果'}
    </span>
  )
}

/**
 * 本地目录引用卡片：展示 local_dir_search 的命中清单。
 * 每次展开“查看原文”都会实时重验授权（与工具读取同一套权限检查），
 * 授权被撤销/解绑/登出后立即失败，不会展示任何未授权内容。
 */
export default function LocalCitationCard({ hits, isActive = false }: LocalCitationCardProps) {
  const [verify, setVerify] = useState<VerifyState>({ phase: 'idle' })

  async function openOriginal(citationId: string) {
    if (isActive) return
    setVerify({ phase: 'loading', citationId })
    try {
      const citation = await agentApi.verifyLocalDirectoryCitation(citationId)
      setVerify({ phase: 'ready', citation })
    } catch (error) {
      setVerify({ phase: 'error', citationId, message: errorText(error) })
    }
  }

  if (!hits.length) return null
  return (
    <section className="lcc" aria-label="本地资料引用" aria-live={isActive ? undefined : 'polite'}>
      <header className="lcc-header">
        <span className="lcc-title">
          <FileSearch size={17} aria-hidden="true" />
          本地资料引用
        </span>
        <span className="lcc-summary">{hits.length} 条命中 · 点按实时重验后查看</span>
      </header>
      <ul className="lcc-list">
        {hits.map((hit) => {
          const busy = verify.phase === 'loading' && verify.citationId === hit.citationId
          const opened = verify.phase === 'ready' && verify.citation.citation_id === hit.citationId
          const failed = verify.phase === 'error' && verify.citationId === hit.citationId
          return (
            <li className="lcc-item" key={hit.citationId}>
              <div className="lcc-item-head">
                <span className="lcc-item-text">
                  <strong title={hit.relativePath || hit.title}>{hit.title}</strong>
                  <small>{hit.snippet}</small>
                </span>
                <button
                  type="button"
                  className="lcc-open"
                  disabled={busy || isActive || opened}
                  onClick={() => void openOriginal(hit.citationId)}
                >
                  {busy ? <LoaderCircle size={14} aria-hidden="true" className="lcc-spinner" />
                    : opened ? <BookOpenText size={14} aria-hidden="true" />
                      : <ShieldCheck size={14} aria-hidden="true" />}
                  {opened ? '已展示' : '查看原文'}
                </button>
              </div>
              {opened && <pre className="lcc-original">{verify.phase === 'ready' ? verify.citation.text : ''}</pre>}
              {failed && <p className="lcc-error" role="alert"><ShieldAlert size={13} aria-hidden="true" /> {verify.phase === 'error' ? verify.message : ''}</p>}
            </li>
          )
        })}
      </ul>
      <p className="lcc-notice">引用只在当前会话本轮内有效；查看原文前会重新校验目录授权，未授权内容不会展示。</p>
    </section>
  )
}
