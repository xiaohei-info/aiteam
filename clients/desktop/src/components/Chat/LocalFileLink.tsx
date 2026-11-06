import { useState, type ReactNode } from 'react'
import { agentApi } from '../../api/agent'
import { openArtifact } from '../../lib/artifactOpen'
import { pickArtifactForPath } from '../../lib/localFileLink'

/** Opens the conversation's generated file that a message links to by path (see lib/localFileLink). */
async function openGeneratedFile(conversationId: string, path: string): Promise<'opened' | 'missing'> {
  const { files } = await agentApi.listFiles(conversationId, 'artifact')
  const file = pickArtifactForPath(files, path)
  if (!file) return 'missing'
  await openArtifact(conversationId, file)
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
