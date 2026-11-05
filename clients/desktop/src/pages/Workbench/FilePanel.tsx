/** 详情栏里选中文件的预览：按格式渲染，可切换源码，可用系统应用打开。 */
import { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy, ExternalLink, FolderSearch, LoaderCircle, TriangleAlert } from 'lucide-react'
import FileIcon from './FileIcon'
import { formatTime } from './format'
import { parseCsv, sandboxedHtml, svgDataUrl } from './preview'
import { fileTypeLabel, formatSize, type ProjectFile } from './projects'
import '../../components/Chat/TextMessage.css'
import styles from './index.module.css'

/** 没有文本内容的文件：不读取，直接提示用系统应用打开。 */
export const BINARY_FORMATS = new Set<ProjectFile['format']>(['image', 'document'])
/** 有渲染预览、可切换到源码的格式。 */
const PREVIEW_FORMATS = new Set<ProjectFile['format']>(['markdown', 'html', 'svg', 'csv'])

export interface ContentState {
  key: string
  loading: boolean
  error: string
  text: string | null
}

export type FileAction = 'open' | 'reveal'

// 文件正文来自本机：只放行 http(s) 链接，图片不加载，避免渲染时访问任意地址。
const markdownComponents: Components = {
  a({ href, children }) {
    if (href && /^https?:\/\//i.test(href)) {
      return <a href={href} target="_blank" rel="noopener noreferrer" className="tm-link">{children}</a>
    }
    return <span className={styles.localRef} title={href}>{children}</span>
  },
  img({ alt }) {
    return <span className={styles.localRef}>[图片{alt ? `：${alt}` : ''}]</span>
  },
}

function ProjectMarkdown({ content }: { content: string }) {
  return <div className={`tm-md ${styles.markdown}`}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</ReactMarkdown>
  </div>
}

export default function FilePanel({ file, content, showSource, copied, pendingAction, actionError, onToggleSource, onCopy, onAction, onRetry }: {
  file: ProjectFile
  content: ContentState | null
  showSource: boolean
  copied: boolean
  pendingAction: FileAction | null
  actionError: string
  onToggleSource: (showSource: boolean) => void
  onCopy: (text: string) => void
  onAction: (action: FileAction) => void
  onRetry: () => void
}) {
  const text = content?.text ?? null
  const canToggle = text !== null && PREVIEW_FORMATS.has(file.format)
  return <article className={styles.filePanel}>
    <div className={styles.fileHeader}>
      <span className={styles.fileIcon}><FileIcon file={file} size={18} /></span>
      <div className={styles.fileTitle}>
        <strong>{file.name}</strong>
        <span title={file.path}>{file.path}</span>
      </div>
      <div className={styles.fileActions}>
        {text !== null && <button type="button" className={styles.smallButton} onClick={() => onCopy(text)} aria-label={`复制 ${file.name} 的内容`}>
          {copied ? <><Check size={13} />已复制</> : <><Copy size={13} />复制</>}
        </button>}
        <button type="button" className={styles.smallButton} disabled={pendingAction !== null} onClick={() => onAction('open')}>
          {pendingAction === 'open' ? <LoaderCircle size={13} className={styles.spinner} /> : <ExternalLink size={13} />}打开
        </button>
        <button type="button" className={styles.smallButton} disabled={pendingAction !== null} onClick={() => onAction('reveal')}>
          {pendingAction === 'reveal' ? <LoaderCircle size={13} className={styles.spinner} /> : <FolderSearch size={13} />}在文件夹中显示
        </button>
      </div>
    </div>
    <div className={styles.fileFacts}>
      <span>{fileTypeLabel(file)}</span>
      <span>{formatSize(file.size)}</span>
      <span>修改于 {formatTime(file.modifiedAt)}</span>
      {canToggle && <span className={styles.viewToggle} role="group" aria-label="显示方式">
        <button type="button" aria-pressed={!showSource} onClick={() => onToggleSource(false)}>预览</button>
        <button type="button" aria-pressed={showSource} onClick={() => onToggleSource(true)}>源码</button>
      </span>}
    </div>
    {actionError && <div className={styles.errorBanner} role="alert"><TriangleAlert size={15} /><span>{actionError}</span></div>}
    {(!content || content.loading) && <div className={styles.detailPlaceholder} role="status"><LoaderCircle className={styles.spinner} size={24} /><span>正在读取文件内容…</span></div>}
    {content?.error && <div className={styles.errorBanner} role="alert">
      <TriangleAlert size={15} /><span>{content.error}</span>
      <button type="button" onClick={onRetry}>重试</button>
    </div>}
    {content && !content.loading && !content.error && <div className={styles.previewBody}><FilePreview file={file} text={text} showSource={showSource} /></div>}
  </article>
}

function FilePreview({ file, text, showSource }: { file: ProjectFile; text: string | null; showSource: boolean }) {
  if (text === null) {
    return <div className={styles.documentPlaceholder}>
      <FileIcon file={file} size={28} />
      <strong>{fileTypeLabel(file)} 文件</strong>
      <span>该文件不支持在页面内预览，请点击「打开」用默认应用查看。</span>
    </div>
  }
  if (!text.trim()) return <p className={styles.hint}>文件内容为空。</p>
  if (showSource) return <pre className={styles.plainText}>{text}</pre>
  switch (file.format) {
    case 'markdown':
      return <ProjectMarkdown content={text} />
    // 空 sandbox：不执行脚本、不共享来源；sandboxedHtml 再禁止加载外部资源。要看运行效果请点「运行」。
    case 'html':
      return <iframe className={styles.htmlFrame} sandbox="" srcDoc={sandboxedHtml(text)} title={`${file.name} 预览`} />
    case 'svg':
      return <div className={styles.svgFrame}><img src={svgDataUrl(text)} alt={file.name} /></div>
    case 'csv':
      return <CsvTable text={text} />
    default:
      return <pre className={styles.plainText}>{text}</pre>
  }
}

const CSV_PREVIEW_ROWS = 200

function CsvTable({ text }: { text: string }) {
  const { rows, truncated } = useMemo(() => parseCsv(text, CSV_PREVIEW_ROWS), [text])
  if (rows.length === 0) return <p className={styles.hint}>文件内容为空。</p>
  const [header, ...body] = rows
  return <div className={styles.csvWrap}>
    <table className={styles.csvTable}>
      <thead><tr>{header.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
      <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
    </table>
    {truncated && <p className={styles.hint}>仅显示前 {CSV_PREVIEW_ROWS} 行，完整内容请用默认应用打开。</p>}
  </div>
}
