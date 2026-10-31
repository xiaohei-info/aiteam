import { useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { agentApi } from '../../api/agent'
import { isTauriRuntime } from '../../api/agent/runtime'
import type { CachedFile } from '../../lib/fileCache'
import { pickArtifactForPath } from '../../lib/localFileLink'

/** Opens the conversation's generated file that a message links to by path (see lib/localFileLink). */
async function openGeneratedFile(conversationId: string, path: string): Promise<'opened' | 'missing'> {
  const { files } = await agentApi.listFiles(conversationId, 'artifact')
  const file = pickArtifactForPath(files, path)
  if (!file) return 'missing'
  const blob = await agentApi.downloadFile(conversationId, 'artifact', file.id)
  if (isTauriRuntime()) {
    const cached = await invoke<CachedFile>('cache_conversation_file', {
      userId: 'conversation-files',
      chatId: conversationId,
      filename: file.filename,
      mimeType: file.mime_type,
      data: Array.from(new Uint8Array(await blob.arrayBuffer())),
    })
    await invoke('open_cached_file', { relPath: cached.rel_path })
  } else {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'
    document.body.appendChild(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return 'opened'
}

export default function LocalFileLink({ conversationId, path, children }: {
  conversationId: string
  path: string
  children?: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const handleOpen = async () => {
    if (busy) return
    setBusy(true); setNotice('')
    try {
      if (await openGeneratedFile(conversationId, path) === 'missing') {
        await navigator.clipboard?.writeText(path).catch(() => undefined)
        setNotice('该文件不在本会话的生成文件里，已复制路径。')
      }
    } catch { setNotice('文件打开失败，请重试。') }
    finally { setBusy(false) }
  }

  return <>
    <button type="button" className="tm-link tm-link-button" title={path} disabled={busy} onClick={() => void handleOpen()}>
      {children}
    </button>
    {notice && <span className="tm-link-notice" role="status">{notice}</span>}
  </>
}
