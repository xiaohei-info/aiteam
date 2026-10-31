import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, FolderKey, FolderOpen, LoaderCircle, RotateCcw, ShieldCheck, X } from 'lucide-react'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import {
  dismissFileAccessStartup, getFileAccessStatus, openFilePrivacySettings,
  registerFileAccessRecovery, selectFileAccessDirectories,
  type FileAccessRecoveryRequest, type FileAccessStatus,
} from '../../lib/fileAccess'
import { fileAccessErrorKind } from '../../lib/fileAccessPolicy'
import FileAccessInstructions from './FileAccessInstructions'
import './FileAccess.css'

export default function FileAccessGate() {
  const [status, setStatus] = useState<FileAccessStatus | null>(null)
  const [startup, setStartup] = useState(false)
  const [request, setRequest] = useState<FileAccessRecoveryRequest | null>(null)
  const pending = useRef<FileAccessRecoveryRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = startup || request !== null
  const dialogRef = useDialogFocus<HTMLDivElement>({ active })

  useEffect(() => {
    let cancelled = false
    void getFileAccessStatus().then(value => {
      if (cancelled) return
      setStatus(value)
      setStartup(Boolean(value && !value.startup_seen))
    }).catch(err => {
      if (!cancelled) {
        setError(String(err))
        setStartup(true)
      }
    })
    const unregister = registerFileAccessRecovery(next => {
      pending.current = next
      setRequest(next)
      setError('')
      void getFileAccessStatus().then(value => { if (!cancelled) setStatus(value) }).catch(() => {})
    })
    return () => {
      cancelled = true
      unregister()
      pending.current?.resolve(false)
      pending.current = null
    }
  }, [])

  const finish = (retry: boolean) => {
    pending.current?.resolve(retry)
    pending.current = null
    setRequest(null)
    setStartup(false)
    setError('')
  }
  const close = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (startup) await dismissFileAccessStartup()
      finish(false)
    } catch (err) { setError(String(err)) }
    finally { setBusy(false) }
  }
  useGlobalShortcutClose({ active, onClose: () => { void close() } })

  if (!active) return null

  const authorize = async () => {
    setBusy(true)
    setError('')
    try {
      const selection = await selectFileAccessDirectories(request?.path ?? status?.suggested_root)
      setStatus(selection.status)
      if (selection.directories.length > 0) finish(true)
      else setError('未选择目录，访问权限未改变。可以重新选择，或稍后在设置中授权。')
    } catch (err) { setError(String(err)) }
    finally { setBusy(false) }
  }
  const systemDenied = request && fileAccessErrorKind(request.error) === 'system'

  return createPortal(
    <div className="file-access-overlay" onMouseDown={event => {
      if (event.target === event.currentTarget) void close()
    }}>
      <div className="file-access-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="file-access-title" aria-describedby="file-access-description" tabIndex={-1}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); void close() } }}>
        <div className="file-access-header">
          <span className={`file-access-icon${systemDenied ? ' warning' : ''}`} aria-hidden="true">
            {systemDenied ? <ShieldCheck size={20} strokeWidth={1.7} /> : <FolderKey size={20} strokeWidth={1.7} />}
          </span>
          <div className="file-access-heading">
            <h2 id="file-access-title">{request ? systemDenied ? '系统限制了文件访问' : '需要文件访问授权' : '授权本机文件访问'}</h2>
            <p id="file-access-description">{request
              ? '重新授权目录或调整系统权限后，即可继续当前操作。'
              : '授权后，可在知识库中扫描、预览和读取本地文件。'}</p>
          </div>
          <button type="button" className="file-access-close" aria-label="关闭授权提示" aria-keyshortcuts="Meta+W Control+W" title="关闭（⌘W / Ctrl+W）" disabled={busy} onClick={() => { void close() }}><X size={17} strokeWidth={1.7} /></button>
        </div>
        <div className="file-access-body">
          <div className="file-access-scope">
            <FolderOpen size={18} strokeWidth={1.7} aria-hidden="true" />
            <div>
              <span>{request ? '当前访问位置' : '选择访问范围'}</span>
              {request?.path ? <p className="file-access-path">{request.path}</p> : <p>{status?.platform === 'windows' ? '分别选择 C:\\、D:\\ 等磁盘根目录，也可只选择文件夹。' : '选择磁盘根目录 /，也可只选择需要的文件夹。'}</p>}
            </div>
          </div>
          <p className="file-access-note"><ShieldCheck size={13} aria-hidden="true" /><span>授权仅保存在本机，不会自动扫描全盘。可随时在设置中取消。</span></p>
          <FileAccessInstructions platform={status?.platform ?? ''} expanded={Boolean(systemDenied)} busy={busy} onOpenSettings={() => {
            void openFilePrivacySettings().catch(err => setError(String(err)))
          }} />
          {request && <button type="button" className="file-access-link file-access-retry" disabled={busy} onClick={() => finish(true)}><RotateCcw size={13} aria-hidden="true" />已调整权限，重试</button>}
          {error && <p role="alert" className="file-access-error"><AlertCircle size={14} aria-hidden="true" /><span>{error}</span></p>}
        </div>
        <div className="file-access-actions file-access-footer">
          <button type="button" disabled={busy} onClick={() => { void close() }}>{request ? '取消本次操作' : '暂不授权'}</button>
          <button type="button" className="primary" data-dialog-initial-focus disabled={busy} onClick={() => { void authorize() }}>
            {busy ? <LoaderCircle className="file-access-spinner" size={14} aria-hidden="true" /> : <FolderKey size={14} aria-hidden="true" />}
            {busy ? '正在授权…' : request ? '选择目录并重试' : '选择根目录授权'}
          </button>
        </div>
      </div>
    </div>, document.body,
  )
}
