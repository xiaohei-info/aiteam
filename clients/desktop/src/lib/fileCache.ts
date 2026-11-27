import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

export interface CachedFile {
  rel_path: string
  /**
   * Absolute location on this machine. When present the message refers to the file by path
   * (`attachment_paths`) and the Agent reads it on demand: nothing is uploaded, whatever the size.
   */
  path?: string
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
/**
 * Opens the file picker and returns the chosen path (null when cancelled). Copying is left to the
 * caller, so a picked file takes the same import route as one dragged in (see ChatInputBar importInto).
 */
export async function pickFilePath(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
  })
  return selected && typeof selected === 'string' ? selected : null
}

/**
 * Copy a file that has a path on disk (chosen in the picker, or dragged in from Finder/Explorer)
 * into the per-chat attachment directory. Rust copies it, so there is no size limit here.
 */
/** Records a dragged-in or picked file where it is, without copying it (attachment by path). */
export function describeLocalFile(srcPath: string): Promise<CachedFile> {
  return invoke<CachedFile>('describe_local_file', { srcPath })
}

export function cacheFileFromPath(userId: string, chatId: string, srcPath: string): Promise<CachedFile> {
  return invoke<CachedFile>('cache_file', { userId, chatId, srcPath })
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf',
  'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json',
}

/** `/` and the like would make the name look like a path; the Rust side rejects those outright. */
function sanitizeFileName(name: string): string {
  const cleaned = Array.from(name, (character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 0x20 || '\\/:*?"<>|'.includes(character) ? '_' : character
  }).join('')
  return cleaned.replace(/^\.+/, '').trim().slice(0, 120)
}

/** Chunked so a large attachment does not blow the argument limit of `String.fromCharCode`. */
async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** A screenshot pasted from the clipboard arrives without a name; give it a readable, unique one. */
function fallbackFileName(mime: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const ext = EXT_BY_MIME[mime] ?? (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '')
  return `${mime.startsWith('image/') ? '粘贴图片' : '粘贴文件'}-${stamp}.${ext || 'bin'}`
}

/**
 * Cache a file the WebView already holds (clipboard paste, drag-and-drop) into the same
 * per-chat attachment directory the native picker writes to, so the result is an ordinary
 * attachment: same preview, same upload, same send.
 */
export async function cacheFileFromBlob(
  userId: string,
  chatId: string,
  blob: Blob,
  fileName?: string,
): Promise<CachedFile> {
  const name = sanitizeFileName(fileName ?? '') || fallbackFileName(blob.type || 'application/octet-stream')
  return invoke<CachedFile>('cache_file_bytes', {
    userId, chatId, fileName: name, dataBase64: await toBase64(blob),
  })
}

/**
 * Pictures a rich-text copy carries only in its RTF (WPS/Word: the HTML points at a temp file in
 * the source app's sandbox). Read natively from the system clipboard; empty outside Tauri or when
 * the clipboard has none.
 */
export async function readClipboardRtfImages(): Promise<File[]> {
  try {
    const images = await invoke<Array<{ name: string; mime: string; dataBase64: string }>>('read_clipboard_rtf_images')
    return images.map(({ name, mime, dataBase64 }) => {
      const raw = atob(dataBase64)
      const bytes = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
      return new File([bytes], name, { type: mime })
    })
  } catch {
    return []
  }
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
