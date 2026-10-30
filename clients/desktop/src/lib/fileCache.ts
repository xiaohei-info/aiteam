import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

export interface CachedFile {
  rel_path: string
  asset_url: string
  name: string
  size: number
  mime: string
}

/**
 * Open native file picker, copy the chosen file into
 * {app_data}/{userId}/{chatId}/file/, return metadata.
 * Returns null if user cancelled.
 */
export async function pickAndCacheFile(userId: string, chatId: string): Promise<CachedFile | null> {
  const selected = await open({
    multiple: false,
    directory: false,
  })
  if (!selected || typeof selected !== 'string') return null

  return invoke<CachedFile>('cache_file', {
    userId,
    chatId,
    srcPath: selected,
  })
}

/**
 * Restore an asset:// URL from a stored rel_path.
 * Call this when rendering a stored file message after restart.
 */
export function resolveCachedFile(relPath: string): Promise<string> {
  return invoke<string>('resolve_cached_file', { relPath })
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** True if MIME indicates an image that can be rendered inline */
export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/') && mime !== 'image/svg+xml'
}

/** Read only an app-owned cached asset; remote downloads use the documented Agent API. */
export async function readCachedFileBlob(file: CachedFile): Promise<Blob> {
  const assetUrl = await resolveCachedFile(file.rel_path)
  if (!assetUrl.startsWith('asset://localhost/')) throw new Error('本地附件地址无效')
  const response = await fetch(assetUrl)
  if (!response.ok) throw new Error(`读取附件失败（${response.status}）`)
  return response.blob()
}
