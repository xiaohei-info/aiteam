import { useEffect, useState } from 'react'
import { AlertCircle, FolderKey, FolderOpen, LoaderCircle, Plus, ShieldCheck } from 'lucide-react'
import FileAccessInstructions from '../../components/FileAccess/FileAccessInstructions'
import '../../components/FileAccess/FileAccess.css'
import {
  FILE_ACCESS_CHANGED, getFileAccessStatus, openFilePrivacySettings,
  revokeFileAccess, selectFileAccessDirectories, type FileAccessStatus,
} from '../../lib/fileAccess'

export default function FileAccessSettings() {
  const [status, setStatus] = useState<FileAccessStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let mounted = true
    const refresh = () => {
      void getFileAccessStatus().then(value => {
        if (mounted) { setStatus(value); setError('') }
      }).catch(err => { if (mounted) setError(String(err)) })
        .finally(() => { if (mounted) setLoading(false) })
    }
    refresh()
    window.addEventListener(FILE_ACCESS_CHANGED, refresh)
    return () => { mounted = false; window.removeEventListener(FILE_ACCESS_CHANGED, refresh) }
  }, [])

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try { await operation() }
    catch (err) { setError(String(err)) }
    finally { setBusy(false) }
  }

  return <section id="file-access" className="settings-card glass-panel" aria-labelledby="settings-file-access-title">
    <div className="settings-section-heading">
      <FolderKey size={16} strokeWidth={1.7} aria-hidden="true" />
      <div>
        <h2 id="settings-file-access-title">本机文件访问权限</h2>
        <p>管理本地文件的扫描、预览与读取范围。</p>
      </div>
      {!loading && status && <span className={`file-access-status ${status.directories.length ? 'granted' : ''}`}>
        {status.directories.length ? `已授权 ${status.directories.length} 个目录` : '未授权'}
      </span>}
    </div>
    {loading ? <p className="file-access-note" role="status"><LoaderCircle className="file-access-spinner" size={14} aria-hidden="true" />正在读取授权…</p> : !status ? <p className="file-access-note" role={error ? 'alert' : undefined}>{error || '请在桌面客户端中管理本机文件访问权限。'}</p> : <>
      {status.directories.length ? <ul className="file-access-grants" aria-label="已授权目录">
        {status.directories.map(directory => <li key={directory}>
          <span className="file-access-directory-icon"><FolderOpen size={17} strokeWidth={1.7} aria-hidden="true" /></span>
          <span className="file-access-directory-path" title={directory}>{directory}</span>
          <button type="button" className="file-access-revoke" disabled={busy} aria-label={`取消授权 ${directory}`} onClick={() => { void run(async () => { setStatus(await revokeFileAccess(directory)) }) }}>取消授权</button>
        </li>)}
      </ul> : <div className="file-access-empty">
        <FolderOpen size={20} strokeWidth={1.5} aria-hidden="true" />
        <div><strong>尚未授权目录</strong><p>添加磁盘或文件夹，开始使用本地知识文件。</p></div>
      </div>}
      <div className="file-access-actions file-access-settings-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => { void run(async () => { setStatus((await selectFileAccessDirectories(status.suggested_root)).status) }) }}><Plus size={14} aria-hidden="true" />添加目录授权</button>
        <button type="button" className="danger" disabled={busy || !status.directories.length} onClick={() => { void run(async () => { setStatus(await revokeFileAccess()) }) }}>取消全部目录授权</button>
      </div>
      <p className="file-access-note"><ShieldCheck size={13} aria-hidden="true" /><span>取消后，目录授权不再恢复；历史扫描记录与已导入文件保留。</span></p>
      <FileAccessInstructions platform={status.platform} busy={busy} onOpenSettings={() => { void run(openFilePrivacySettings) }} />
    </>}
    {error && status && <p role="alert" className="file-access-error"><AlertCircle size={14} aria-hidden="true" /><span>{error}</span></p>}
  </section>
}
