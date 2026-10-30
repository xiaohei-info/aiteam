import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { SafeDiagnostic } from '../../lib/appDiagnostics'
import { formatSafeDiagnostic } from '../../lib/appDiagnostics'

interface DiagnosticPanelProps {
  diagnostic: SafeDiagnostic
}

type CopyState = 'idle' | 'copied' | 'failed'

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('copy_unavailable')
}

export default function DiagnosticPanel({ diagnostic }: DiagnosticPanelProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle')

  const handleCopy = async () => {
    try {
      await copyText(formatSafeDiagnostic(diagnostic))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <section className="app-diagnostic" aria-label="安全诊断信息">
      <div className="app-diagnostic-heading">
        <div>
          <span>错误编号</span>
          <strong>{diagnostic.errorId}</strong>
        </div>
        <button type="button" onClick={() => void handleCopy()}>
          {copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
          {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制诊断信息'}
        </button>
      </div>
      <dl>
        <div><dt>错误码</dt><dd>{diagnostic.code}</dd></div>
        <div><dt>阶段</dt><dd>{diagnostic.stage}</dd></div>
        <div><dt>类别</dt><dd>{diagnostic.category}</dd></div>
        <div><dt>模块</dt><dd>{diagnostic.view}</dd></div>
        <div><dt>时间</dt><dd>{diagnostic.occurredAt}</dd></div>
      </dl>
      <p>诊断摘要不包含账号凭据、请求内容或错误堆栈，可安全提供给技术支持。</p>
    </section>
  )
}
