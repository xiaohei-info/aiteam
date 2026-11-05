/** 代码项目安装依赖的下载源设置。 */
import { useState } from 'react'
import { Download, LoaderCircle, TriangleAlert } from 'lucide-react'
import { ChatDialog } from '../../components/Chat/ChatDialog'
import { setDependencySource } from './api'
import { errorText } from './format'
import { NPM_MIRROR, PYPI_MIRROR, sourceUrlError, type DependencySource } from './projects'
import styles from './index.module.css'

const SOURCE_OPTIONS: { mode: DependencySource['mode']; title: string; detail: string }[] = [
  { mode: 'mirror', title: '国内镜像（推荐）', detail: 'Python 用清华 PyPI 镜像，Node 用 npmmirror' },
  { mode: 'system', title: '跟随系统配置', detail: '使用本机 pip.conf、.npmrc 中的设置，未设置时为官方源' },
  { mode: 'custom', title: '自定义', detail: '填写公司内部或其他镜像地址；留空的一项跟随系统配置' },
]

export default function DependencySourceDialog({ value, onClose, onSaved }: {
  value: DependencySource
  onClose: () => void
  onSaved: (source: DependencySource) => void
}) {
  const [mode, setMode] = useState<DependencySource['mode']>(value.mode)
  const [pypi, setPypi] = useState(value.mode === 'custom' ? value.pypi ?? '' : '')
  const [npm, setNpm] = useState(value.mode === 'custom' ? value.npm ?? '' : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const pypiError = mode === 'custom' ? sourceUrlError(pypi) : null
  const npmError = mode === 'custom' ? sourceUrlError(npm) : null

  const save = async () => {
    if (saving || pypiError || npmError) return
    const next: DependencySource = mode === 'custom'
      ? { mode, pypi: pypi.trim() || null, npm: npm.trim() || null }
      : { mode }
    setSaving(true)
    setError('')
    try {
      onSaved(await setDependencySource(next))
    } catch (failure) {
      setError(errorText(failure, '保存下载源失败，请重试'))
      setSaving(false)
    }
  }

  return <ChatDialog title="依赖下载源" icon={<Download size={18} />} description="运行 Node / Python 项目时安装依赖用的地址" onClose={onClose}>
    <div className={styles.sourceOptions} role="radiogroup" aria-label="下载源">
      {SOURCE_OPTIONS.map(option => <label key={option.mode} className={`${styles.sourceOption} ${mode === option.mode ? styles.sourceOptionActive : ''}`}>
        <input type="radio" name="dependency-source" checked={mode === option.mode} onChange={() => setMode(option.mode)} />
        <span><strong>{option.title}</strong><small>{option.detail}</small></span>
      </label>)}
    </div>
    {mode === 'custom' && <div className={styles.sourceFields}>
      <label>
        <span>Python（PyPI 索引地址）</span>
        <input value={pypi} maxLength={512} placeholder={PYPI_MIRROR} aria-invalid={Boolean(pypiError)} onChange={event => setPypi(event.target.value)} />
        {pypiError && <small className={styles.fieldError}>{pypiError}</small>}
      </label>
      <label>
        <span>Node（npm registry）</span>
        <input value={npm} maxLength={512} placeholder={NPM_MIRROR} aria-invalid={Boolean(npmError)} onChange={event => setNpm(event.target.value)} />
        {npmError && <small className={styles.fieldError}>{npmError}</small>}
      </label>
    </div>}
    <p className="chat-tools-note">更换下载源会改变安装命令，每个代码项目下次运行前需要重新确认；已安装的依赖不会重新下载。</p>
    {error && <div className={styles.errorBanner} role="alert"><TriangleAlert size={15} /><span>{error}</span></div>}
    <footer>
      <button type="button" onClick={onClose}>取消</button>
      <button type="button" className={styles.consentConfirm} disabled={saving || Boolean(pypiError || npmError)} onClick={() => void save()}>
        {saving && <LoaderCircle size={14} className={styles.spinner} />}保存
      </button>
    </footer>
  </ChatDialog>
}
