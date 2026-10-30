import { useEffect, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openLocalKnowledgeFile, previewLocalKnowledgeFile, readFileAsBase64 } from './api'
import type { ScannedKnowledgeFile } from './types'
import { getScannedFileType } from './utils'

const PREVIEW_MAX_CHARS_TEXT = '30,000'
const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'])
const TEXT_TYPES = new Set(['md', 'markdown', 'csv', 'txt', 'json', 'log', 'docx'])

type WebviewState =
  | { status: 'loading' }
  | { status: 'image'; url: string }
  | { status: 'frame'; url: string; truncated: boolean }
  | { status: 'unsupported' }
  | { status: 'error'; message: string }

const PREVIEW_DOCUMENT_STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px 28px; background: #0b0c11; color: #e8e8ee; font: 14px/1.78 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; word-break: break-word; }
  h1, h2, h3, h4, h5, h6 { margin: 1.4em 0 0.6em; line-height: 1.35; }
  h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
  p, ul, ol { margin: 0 0 0.9em; }
  a { color: #d4af37; }
  code { border-radius: 4px; background: rgba(255,255,255,0.08); font-family: "SF Mono", Menlo, monospace; font-size: 0.9em; padding: 1px 5px; }
  pre { margin: 0 0 1em; overflow: auto; border-radius: 8px; background: rgba(255,255,255,0.05); padding: 12px 14px; }
  pre code { background: none; padding: 0; }
  pre.plain { border-radius: 0; background: none; font-family: "SF Mono", Menlo, monospace; font-size: 12.5px; line-height: 1.7; padding: 0; white-space: pre-wrap; }
  table { border-collapse: collapse; margin: 0 0 1em; }
  th, td { border: 1px solid rgba(255,255,255,0.14); padding: 6px 10px; }
  th { background: rgba(255,255,255,0.06); }
  blockquote { margin: 0 0 1em; border-left: 3px solid rgba(212,175,55,0.6); color: #b8b8c4; padding-left: 14px; }
  img { max-width: 100%; }
`

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildPreviewDocument(body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PREVIEW_DOCUMENT_STYLE}</style></head><body>${body}</body></html>`
}

function base64ToBlob(base64: string, type: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type })
}

function imageMimeType(fileType: string) {
  if (fileType === 'svg') return 'image/svg+xml'
  return `image/${fileType === 'jpg' ? 'jpeg' : fileType}`
}

function getErrorText(error: unknown) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : '文件预览失败'
}

/** 本地文件预览：统一转成 blob 文档后交给 WebView（iframe）渲染，不放宽 asset 协议的访问范围。 */
export default function LocalFileWebview({ file }: { file: ScannedKnowledgeFile }) {
  const [state, setState] = useState<WebviewState>({ status: 'loading' })
  const [openError, setOpenError] = useState('')

  useEffect(() => {
    let cancelled = false
    let objectUrl = ''
    const fileType = getScannedFileType(file.name)
    const publish = (blob: Blob) => {
      objectUrl = URL.createObjectURL(blob)
      return objectUrl
    }

    setState({ status: 'loading' })
    setOpenError('')
    void (async () => {
      try {
        if (fileType === 'pdf') {
          const url = publish(base64ToBlob(await readFileAsBase64(file.path), 'application/pdf'))
          if (!cancelled) setState({ status: 'frame', url, truncated: false })
        } else if (IMAGE_TYPES.has(fileType)) {
          const url = publish(base64ToBlob(await readFileAsBase64(file.path), imageMimeType(fileType)))
          if (!cancelled) setState({ status: 'image', url })
        } else if (TEXT_TYPES.has(fileType)) {
          const preview = await previewLocalKnowledgeFile(file.path)
          const type = preview.file_type.toLowerCase()
          const body = type === 'md' || type === 'markdown'
            ? renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.content}</ReactMarkdown>)
            : `<pre class="plain">${escapeHtml(preview.content)}</pre>`
          const url = publish(new Blob(
            [buildPreviewDocument(preview.content.trim() ? body : '<p>这个文件没有可预览内容。</p>')],
            { type: 'text/html;charset=utf-8' },
          ))
          if (!cancelled) setState({ status: 'frame', url, truncated: preview.truncated })
        } else if (!cancelled) {
          setState({ status: 'unsupported' })
        }
      } catch (error) {
        if (!cancelled) setState({ status: 'error', message: getErrorText(error) })
      }
    })()

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file.path, file.name])

  const handleOpenOriginal = async () => {
    setOpenError('')
    try {
      await openLocalKnowledgeFile(file.path)
    } catch (error) {
      setOpenError(getErrorText(error))
    }
  }

  if (state.status === 'loading') return <div className="kb-scan-preview-state">正在读取文件...</div>
  if (state.status === 'error' || state.status === 'unsupported') {
    return (
      <div className={`kb-scan-preview-state ${state.status === 'error' ? 'error' : ''}`}>
        <div className="kb-webview-fallback">
          <p>{state.status === 'error' ? state.message : '当前文件类型暂不支持内置预览。'}</p>
          <button type="button" className="kb-panel-action" onClick={() => void handleOpenOriginal()}>用默认应用打开</button>
          {openError && <p className="kb-webview-fallback-error">{openError}</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="kb-webview">
      {state.status === 'frame' && state.truncated && (
        <p className="kb-scan-preview-note">文件较大，当前仅显示前 {PREVIEW_MAX_CHARS_TEXT} 字。</p>
      )}
      {state.status === 'image' ? (
        <div className="kb-webview-image"><img src={state.url} alt={file.name} /></div>
      ) : (
        <iframe
          className="kb-webview-frame"
          src={state.url}
          title={file.name}
          sandbox={getScannedFileType(file.name) === 'pdf' ? undefined : ''}
        />
      )}
    </div>
  )
}
