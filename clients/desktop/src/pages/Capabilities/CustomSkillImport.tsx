/**
 * 「添加技能 → 自定义」的一屏：一次只显示一种来源（文件夹 / zip / 粘贴 SKILL.md / 网址）。
 * 先「检查」拿预览，再「安装」；粘贴框检查后清空。来源切换不清掉未安装的草稿。
 */
import { useState } from 'react'
import { FolderOpen, LoaderCircle, FileArchive, ClipboardPaste, Globe } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { agentApi, AgentApiError } from '../../api/agent'
import type { CustomSkillPreview, CustomSkillSource } from '../../api/agent/capabilities'
import { formatFileSize } from '../../lib/fileCache'

const SOURCES: { id: CustomSkillSource; label: string; icon: typeof FolderOpen; hint: string }[] = [
  { id: 'folder', label: '文件夹', icon: FolderOpen, hint: '选一个含 SKILL.md 的文件夹（可以带模板、脚本、参考资料）。' },
  { id: 'zip', label: 'zip', icon: FileArchive, hint: '选一个技能压缩包（.zip）。' },
  { id: 'text', label: '粘贴 SKILL.md', icon: ClipboardPaste, hint: '直接粘贴 SKILL.md 全文，只能做单文件技能。' },
  { id: 'url', label: '网址', icon: Globe, hint: '公开 https 地址：GitHub 仓库 / 子目录、单个 .md、zip。' },
]

function errorText(error: unknown): string {
  if (error instanceof AgentApiError && error.status === 413) return '技能太大，超过上限。'
  if (error instanceof AgentApiError && error.status === 502) return '下载失败，请检查网址或稍后再试。'
  return error instanceof Error && error.message ? error.message : '检查失败，请重试'
}

export function CustomSkillImport({ onInstalled, onClose }: { onInstalled: () => Promise<void> | void; onClose: () => void }) {
  const [source, setSource] = useState<CustomSkillSource>('folder')
  const [path, setPath] = useState('')
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<boolean | null>(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<CustomSkillPreview | null>(null)

  const current = SOURCES.find((item) => item.id === source)!

  const pick = async (kind: 'folder' | 'zip') => {
    const selected = await open({
      multiple: false,
      directory: kind === 'folder',
      filters: kind === 'zip' ? [{ name: '技能压缩包', extensions: ['zip'] }] : undefined,
    })
    if (!selected || typeof selected !== 'string') return
    setPath(selected)
    setPreview(null)
  }

  const check = async () => {
    setBusy(true); setError('')
    try {
      const result = await agentApi.importCustomSkill({
        source,
        ...(source === 'folder' || source === 'zip' ? { path } : {}),
        ...(source === 'text' ? { skill_md: text } : {}),
        ...(source === 'url' ? { url } : {}),
        preview: true,
      })
      if (!result?.preview) throw new Error('没有返回预览')
      setPreview(result.preview)
      if (source === 'text') setText('')
    } catch (err) {
      setError(errorText(err))
    } finally { setBusy(null) }
  }

  const install = async () => {
    setBusy(true); setError('')
    try {
      const result = await agentApi.importCustomSkill({
        source,
        ...(source === 'folder' || source === 'zip' ? { path } : {}),
        ...(source === 'text' ? { skill_md: text } : {}),
        ...(source === 'url' ? { url } : {}),
        preview: false,
      })
      if (!result?.capability) throw new Error('安装未完成')
      await onInstalled()
      onClose()
    } catch (err) {
      setError(errorText(err))
      setPreview(null)
    } finally { setBusy(null) }
  }

  const ready = source === 'folder' || source === 'zip' ? path.trim().length > 0
    : source === 'text' ? text.trim().length > 0
      : url.trim().length > 0

  return <div className="mcp-form custom-skill-import">
    <div className="skill-source-tabs" role="tablist" aria-label="技能来源">
      {SOURCES.map((item) => {
        const Icon = item.icon
        return <button key={item.id} type="button" role="tab" aria-selected={source === item.id}
          className={source === item.id ? 'on' : ''} onClick={() => { setSource(item.id); setError(''); setPreview(null) }}>
          <Icon size={13} aria-hidden="true" />{item.label}
        </button>
      })}
    </div>
    <p className="mcp-note">{current.hint}</p>

    {source === 'folder' || source === 'zip'
      ? <label>已选{source === 'folder' ? '文件夹' : '压缩包'}
        <span className="skill-pick">
          <input aria-label={source === 'folder' ? '文件夹路径' : '压缩包路径'} readOnly value={path} placeholder={`点右侧选择${source === 'folder' ? '文件夹' : 'zip'}…`} />
          <button type="button" onClick={() => void pick(source)}>选择…</button>
        </span>
      </label>
      : source === 'text'
        ? <label>SKILL.md 内容
          <textarea aria-label="SKILL.md 内容" rows={9} value={text} onChange={(event) => setText(event.target.value)}
            placeholder={'---\nname: my-skill\ndescription: 这个技能做什么\n---\n\n# 说明\n'} />
        </label>
        : <label>网址
          <input aria-label="技能网址" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/…" inputMode="url" />
        </label>}

    {error && <p role="alert" className="mcp-error">{error}</p>}

    {preview && <div className="skill-preview" aria-label="技能预览">
      <div className="skill-preview-row"><span>名称</span><strong>{preview.name}</strong></div>
      <div className="skill-preview-row"><span>说明</span><span>{preview.description}</span></div>
      <div className="skill-preview-row"><span>文件</span><span>{preview.file_count} 个 · {formatFileSize(preview.total_bytes)}</span></div>
      <div className="skill-preview-row"><span>来源</span><span>{preview.origin_label}</span></div>
      <ul className="skill-preview-files">
        {preview.files.map((file) => <li key={file}>{file}</li>)}
        {preview.file_count > preview.files.length && <li>…（共 {preview.file_count} 个）</li>}
      </ul>
    </div>}

    <footer>
      <button type="button" onClick={onClose}>取消</button>
      {preview
        ? <button type="button" className="skill-install" disabled={busy === true} onClick={() => void install()}>{busy ? '正在安装…' : '安装'}</button>
        : <button type="button" className="skill-install" disabled={busy || !ready} onClick={() => void check()}>
          {busy ? '正在检查…' : '检查'}
        </button>}
    </footer>
    {busy && <LoaderCircle className="file-access-spinner skill-busy" size={13} aria-hidden="true" />}
  </div>
}
