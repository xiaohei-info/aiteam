/**
 * 「添加技能 → 自定义」的一屏：一次只显示一种来源（文件夹 / zip / 单个 .md / 粘贴 SKILL.md / 网址）。
 * 先「检查」拿预览，再「安装」；粘贴框检查后清空。来源切换不清掉未安装的草稿。
 */
import { useState } from 'react'
import { FolderOpen, LoaderCircle, FileArchive, ClipboardPaste, Globe, FileText, BadgeCheck } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { agentApi, AgentApiError } from '../../api/agent'
import type { CustomSkillPreview, CustomSkillScanItem, CustomSkillSource } from '../../api/agent/capabilities'
import { formatFileSize } from '../../lib/fileCache'
import { toLocalPath } from '../../lib/localSkillPath'
import { canInstall, defaultPicked, installButtonLabel, normalizePicked, togglePicked } from '../../lib/skillScanSelection'
import { alreadyInstalledText, partitionInstallResults } from '../../lib/alreadyInstalled'
import type { CustomSkillInstallResultItem } from '../../api/agent/capabilities'

/** 一次安装的逐条结果：成功 / 重复（已装） / 真失败。 */
interface InstallOutcome {
  installed: CustomSkillInstallResultItem[]
  already: CustomSkillInstallResultItem[]
  failed: CustomSkillInstallResultItem[]
}

const skillLabel = (item: CustomSkillInstallResultItem) => item.name || item.root || '（包根）'

/** 结果就用一段文案，按成功 / 重复 / 失败分行，不做列表。 */
function outcomeText(outcome: InstallOutcome): string {
  const lines: string[] = []
  if (outcome.installed.length > 0) lines.push(`成功：${outcome.installed.map(skillLabel).join('、')}`)
  if (outcome.already.length > 0) lines.push(`重复：${outcome.already.map(skillLabel).join('、')}（已装，无需重装）`)
  if (outcome.failed.length > 0) lines.push(`失败：${outcome.failed.map((item) => `${skillLabel(item)}（${item.reason || '安装失败'}）`).join('；')}`)
  return lines.join('\n')
}


const SOURCES: { id: CustomSkillSource; label: string; icon: typeof FolderOpen; hint: string }[] = [
  { id: 'folder', label: '文件夹', icon: FolderOpen, hint: '选一个含 SKILL.md 的文件夹（可以带模板、脚本、参考资料）。' },
  { id: 'zip', label: 'zip', icon: FileArchive, hint: '选一个技能压缩包（.zip）。' },
  { id: 'file', label: '单个 .md', icon: FileText, hint: '选一个 SKILL.md 文件；技能名取自文件里的 name，与文件名无关。' },
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
  /** 撞同名已装：不是错误，是「已经装好了」的状态提示。 */
  const [installed, setInstalled] = useState('')
  /** 安装完成后的结果文案：成功 / 重复 / 失败分行，位置就在原提示处。 */
  const [outcome, setOutcome] = useState('')
  const [preview, setPreview] = useState<CustomSkillPreview | null>(null)
  const [scan, setScan] = useState<CustomSkillScanItem[] | null>(null)
  const [picked, setPicked] = useState<string[]>([])

  const current = SOURCES.find((item) => item.id === source)!

  const pick = async (kind: 'folder' | 'zip' | 'file') => {
    const selected = await open({
      multiple: false,
      directory: kind === 'folder',
      filters: kind === 'zip' ? [{ name: '技能压缩包', extensions: ['zip'] }]
        : kind === 'file' ? [{ name: '技能说明', extensions: ['md'] }] : undefined,
    })
    if (!selected || typeof selected !== 'string') return
    setPath(toLocalPath(selected))
    setPreview(null)
  }

  const check = async () => {
    setBusy(true); setError(''); setInstalled(''); setOutcome('')
    try {
      const result = await agentApi.importCustomSkill({
        source,
        ...(source === 'folder' || source === 'zip' || source === 'file' ? { path } : {}),
        ...(source === 'text' ? { skill_md: text } : {}),
        ...(source === 'url' ? { url } : {}),
        preview: true,
      })
      if (result?.scan) {
        setScan(result.scan)
        setPicked(defaultPicked(result.scan))
        setPreview(null)
        return
      }
      if (!result?.preview) throw new Error('没有返回预览')
      setPreview(result.preview)
      setScan(null)
      setPicked([])
      if (source === 'text') setText('')
    } catch (err) {
      const text = alreadyInstalledText(err)
      if (text) { setInstalled(text); setPreview(null); setScan(null); setPicked([]) }
      else setError(errorText(err))
    } finally { setBusy(null) }
  }

  const install = async () => {
    setBusy(true); setError(''); setInstalled(''); setOutcome('')
    try {
      const result = await agentApi.importCustomSkill({
        source,
        ...(source === 'folder' || source === 'zip' || source === 'file' ? { path } : {}),
        ...(source === 'text' ? { skill_md: text } : {}),
        ...(source === 'url' ? { url } : {}),
        ...(scan ? { roots: normalizePicked(scan, picked) } : {}),
        preview: false,
      })
      if (result?.results) {
        // 「已经装好了」不算失败：成功的列出来，重复的标「重复」，只有真失败才给原因。
        const { installed: done, already, failed } = partitionInstallResults(result.results)
        await onInstalled()
        setOutcome(outcomeText({ installed: done, already, failed }))
        return
      }
      if (!result?.capability) throw new Error('安装未完成')
      await onInstalled()
      // 单个技能也给一句结果，用户能看到到底装了什么。
      setOutcome(`成功：${result.capability.ref}`)
    } catch (err) {
      const text = alreadyInstalledText(err)
      if (text) { setInstalled(text); setError('') }
      else setError(errorText(err))
      setOutcome('')
      setPreview(null)
      setScan(null)
      setPicked([])
    } finally { setBusy(null) }
  }


  const ready = source === 'folder' || source === 'zip' || source === 'file' ? path.trim().length > 0
    : source === 'text' ? text.trim().length > 0
      : url.trim().length > 0

  const pickedLabel = source === 'file' ? '.md 文件' : source === 'zip' ? '压缩包' : '文件夹'

  const sourceField = (source === 'folder' || source === 'zip' || source === 'file')
      ? <label>已选{pickedLabel}
        <span className="skill-pick">
          <input aria-label={`${pickedLabel}路径`} readOnly value={path} placeholder={`点右侧选择${pickedLabel}…`} />
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
        </label>

  return <div className="mcp-form custom-skill-import">
    {scan && <div className="skill-scan" aria-label="包内技能清单">
      <p className="mcp-note">这个包里有 {scan.length} 个技能，勾选要安装的：</p>
      <ul>
        {scan.map((item) => <li key={item.root} className={item.ok ? '' : 'invalid'}>
          <label>
            <input type="checkbox" aria-label={`选择 ${item.root || '包根'}`} disabled={!item.ok}
              checked={picked.includes(item.root)}
              onChange={() => setPicked((current) => togglePicked(current, item.root))} />
            <span className="skill-scan-copy">
              <strong>{item.ok ? (item.name || item.root || '（包根）') : item.root || '（包根）'}</strong>
              <span>{item.ok ? `${item.description} · ${item.file_count} 个文件 · ${formatFileSize(item.total_bytes)}` : item.reason}</span>
            </span>
          </label>
        </li>)}
      </ul>
    </div>}

    <div className="skill-source-tabs" role="tablist" aria-label="技能来源">
      {SOURCES.map((item) => {
        const Icon = item.icon
        return <button key={item.id} type="button" role="tab" aria-selected={source === item.id}
          className={source === item.id ? 'on' : ''} onClick={() => { setSource(item.id); setError(''); setInstalled(''); setOutcome(''); setPreview(null) }}>
          <Icon size={13} aria-hidden="true" />{item.label}
        </button>
      })}
    </div>
    <p className="mcp-note">{current.hint}</p>

    {sourceField}

    {error && <p role="alert" className="mcp-error">{error}</p>}
    {installed && <p className="mcp-note installed-note" role="status"><BadgeCheck size={14} aria-hidden="true" />{installed}</p>}
    {outcome && <p className="mcp-note outcome-note" role="status">{outcome}</p>}

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
      {scan
        ? <button type="button" className="skill-install" disabled={!canInstall(picked.length, busy)} onClick={() => void install()}>{installButtonLabel(picked.length, busy === true)}</button>
        : preview
          ? <button type="button" className="skill-install" disabled={busy === true} onClick={() => void install()}>{busy ? '正在安装…' : '安装'}</button>
          : <button type="button" className="skill-install" disabled={busy || !ready} onClick={() => void check()}>
            {busy ? '正在检查…' : '检查'}
          </button>}
    </footer>
    {busy && <LoaderCircle className="file-access-spinner skill-busy" size={13} aria-hidden="true" />}
  </div>
}
