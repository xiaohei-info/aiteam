import { invoke } from '@tauri-apps/api/core'
import { agentApi } from '../api/agent'
import { isTauriRuntime } from '../api/agent/runtime'
import type { CachedFile } from './fileCache'

interface ArtifactRef {
  id: string
  filename: string
  mime_type?: string
}

/** Copies a generated file into the desktop file cache and returns its cache path.
 *  Keyed by the file ID, so repeated opens or reveals overwrite one copy instead of adding new ones. */
async function cacheArtifact(conversationId: string, file: ArtifactRef): Promise<string> {
  const blob = await agentApi.downloadFile(conversationId, 'artifact', file.id)
  const cached = await invoke<CachedFile>('cache_conversation_file', {
    userId: 'conversation-files',
    chatId: conversationId,
    filename: file.filename,
    mimeType: file.mime_type || blob.type || 'application/octet-stream',
    data: Array.from(new Uint8Array(await blob.arrayBuffer())),
    cacheKey: `artifact:${file.id}`,
  })
  return cached.rel_path
}

/** Opens a generated file with the system app (desktop) or in a new tab (browser). */
export async function openArtifact(conversationId: string, file: ArtifactRef): Promise<void> {
  if (isTauriRuntime()) {
    await invoke('open_cached_file', { relPath: await cacheArtifact(conversationId, file) })
    return
  }
  const blob = await agentApi.downloadFile(conversationId, 'artifact', file.id)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'
  document.body.appendChild(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Shows a local copy of the generated file in Finder; desktop only. */
export async function revealArtifact(conversationId: string, file: ArtifactRef): Promise<void> {
  await invoke('show_in_folder', { relPath: await cacheArtifact(conversationId, file) })
}
