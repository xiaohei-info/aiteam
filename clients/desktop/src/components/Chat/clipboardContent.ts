/**
 * Turns what a paste or a drop carries (plain text, HTML and files) into the text to insert plus
 * the files to attach. Pictures and files keep their place in the text as a placeholder that names
 * the attachment, so a message like “看这张 [图片：图1.png] 和这张 [图片：图2.png]” still says
 * which picture is which after the pictures move to the attachment list.
 *
 * The composition itself is DOM-free so it can be unit tested; `htmlToParts` is the only part
 * that needs a browser.
 */

export type PastePart =
  | { kind: 'text'; text: string }
  /** `file` is set when the picture's bytes are known (data: URL or a fetched remote image). */
  | { kind: 'image'; name: string; src?: string; file?: File }

export interface ComposedPaste {
  /** Text to insert; empty when the clipboard only held attachments. */
  text: string
  /** Files to attach, renamed so every placeholder points at exactly one attachment. */
  files: File[]
  /**
   * Pictures that only came as an address. Their placeholder is already in `text` under `name`;
   * the caller fetches `src` afterwards and attaches it, or tells the user it could not.
   */
  pending: Array<{ name: string; src: string }>
  /**
   * Pictures the source app did not put on the clipboard at all: only a private reference such as
   * Feishu's `native-resource://…`. Nothing can fetch them, so they get no placeholder; the caller
   * tells the user to copy the picture on its own.
   */
  unavailable: number
}

/**
 * Files carried by a paste or a drop. `DataTransfer.files` is empty for a dragged file until the
 * drop itself fires, so `items` / `types` answer "is a file coming" during dragover.
 */
export function filesOf(data: DataTransfer | null | undefined): File[] {
  if (!data) return []
  if (data.files && data.files.length > 0) return Array.from(data.files)
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

export function carriesFiles(data: DataTransfer | null | undefined): boolean {
  if (!data) return false
  if (data.files && data.files.length > 0) return true
  if (Array.from(data.types ?? []).includes('Files')) return true
  return Array.from(data.items ?? []).some((item) => item.kind === 'file')
}

export function placeholderFor(name: string, type: string): string {
  return type.startsWith('image/') ? `[图片：${name}]` : `[文件：${name}]`
}

function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
}

/** Gives repeated names (every screenshot is “image.png”) a running number. */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name)
    return name
  }
  const [stem, ext] = splitName(name)
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}${ext}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}

function renamed(file: File, name: string): File {
  return file.name === name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified })
}

function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '')
}

/**
 * Finder (and most file managers) put the copied files' names on the clipboard as plain text next
 * to the files themselves. That text is not something the user wrote, so it must not be pasted.
 */
function isJustFileNames(plain: string, files: File[]): boolean {
  const lines = plain.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0 || files.length === 0) return false
  const names = new Set(files.map((file) => file.name))
  return lines.every((line) => names.has(line) || names.has(line.split('/').pop() ?? ''))
}

export function composePaste(input: { plain: string; parts: PastePart[]; files: File[] }): ComposedPaste {
  const { plain, parts, files } = input
  const hasHtmlImage = parts.some((part) => part.kind === 'image')
  if (files.length === 0 && !hasHtmlImage) return { text: plain, files: [], pending: [], unavailable: 0 }
  if (!hasHtmlImage && (!plain.trim() || isJustFileNames(plain, files))) {
    return { text: '', files: uniqueFiles(files), pending: [], unavailable: 0 }
  }

  const taken = new Set<string>()
  const attachments: File[] = []
  const pending: ComposedPaste['pending'] = []
  let unavailable = 0
  const attach = (file: File): string => {
    const named = renamed(file, uniqueName(file.name, taken))
    attachments.push(named)
    return placeholderFor(named.name, named.type)
  }

  // Pictures in the HTML that came without bytes take the clipboard's image files in order:
  // that is how Word/WPS/web pages hand over the pictures of a copied passage.
  const spare = [...files]
  const takeSpareImage = (): File | undefined => {
    const index = spare.findIndex((file) => file.type.startsWith('image/'))
    return index < 0 ? undefined : spare.splice(index, 1)[0]
  }

  let text = ''
  if (hasHtmlImage) {
    for (const part of parts) {
      if (part.kind === 'text') {
        text += part.text
        continue
      }
      const file = part.file ?? takeSpareImage()
      if (file) {
        text += attach(file)
      } else if (!/^https?:/i.test(part.src ?? '')) {
        unavailable += 1
      } else {
        const name = uniqueName(part.name, taken)
        pending.push({ name, src: part.src ?? '' })
        text += placeholderFor(name, 'image/')
      }
    }
  } else {
    text = plain
  }
  // Files whose place in the text is unknown (e.g. a screenshot pasted together with text) go last.
  const rest = spare.map(attach)
  text = tidy(text)
  if (rest.length > 0) text = text ? `${text}\n${rest.join('\n')}` : rest.join('\n')

  const words = text.replace(/\[(?:图片|文件)：[^\]]*\]/g, '').trim()
  if (!words && pending.length === 0) return { text: '', files: attachments, pending, unavailable }
  return { text, files: attachments, pending, unavailable }
}

function uniqueFiles(files: File[]): File[] {
  const taken = new Set<string>()
  return files.map((file) => renamed(file, uniqueName(file.name, taken)))
}

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P',
  'PRE', 'SECTION', 'TABLE', 'TR', 'UL',
])
const SKIPPED_TAGS = new Set(['HEAD', 'META', 'SCRIPT', 'STYLE', 'TITLE', 'TEMPLATE', 'NOSCRIPT'])

function nameFromSrc(src: string, alt: string, type: string): string {
  const extension = type.split('/')[1]?.replace('jpeg', 'jpg').replace(/\+.*$/, '') || 'png'
  if (!src.startsWith('data:')) {
    const base = decodeURIComponent(src.split(/[?#]/)[0].split('/').pop() ?? '')
    if (/\.[a-z0-9]{2,5}$/i.test(base)) return base
  }
  const stem = alt.trim().replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 40).trim() || '图片'
  return `${stem}.${extension}`
}

function fileFromDataUrl(src: string, name: string): File | undefined {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src)
  if (!match || !match[1].startsWith('image/')) return undefined
  try {
    const raw = match[2] ? atob(match[3]) : decodeURIComponent(match[3])
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0))
    return new File([bytes], name, { type: match[1] })
  } catch {
    return undefined
  }
}

/** Splits clipboard HTML into text runs and pictures in reading order (browser only). */
export function htmlToParts(html: string): PastePart[] {
  if (!html || !/<img\b/i.test(html)) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const parts: PastePart[] = []
  let buffer = ''
  const flush = () => {
    if (buffer) parts.push({ kind: 'text', text: buffer })
    buffer = ''
  }
  const newline = () => {
    if (buffer && !buffer.endsWith('\n')) buffer += '\n'
    else if (!buffer && parts.length > 0) buffer = '\n'
  }
  const walk = (node: Node, pre: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? ''
      buffer += pre ? value : value.replace(/\s+/g, ' ')
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    const tag = element.tagName
    if (SKIPPED_TAGS.has(tag)) return
    if (tag === 'BR') {
      buffer += '\n'
      return
    }
    if (tag === 'IMG') {
      const src = element.getAttribute('src') ?? ''
      const alt = element.getAttribute('alt') ?? ''
      const type = /^data:([^;,]+)/.exec(src)?.[1] ?? 'image/png'
      const name = nameFromSrc(src, alt, type)
      flush()
      parts.push({ kind: 'image', name, src, file: src.startsWith('data:') ? fileFromDataUrl(src, name) : undefined })
      return
    }
    const block = BLOCK_TAGS.has(tag)
    if (block) newline()
    for (const child of Array.from(element.childNodes)) walk(child, pre || tag === 'PRE')
    if (block) newline()
    else if (tag === 'TD' || tag === 'TH') buffer += ' '
  }
  walk(doc.body, false)
  flush()
  return parts
}

/** Fetches a picture that only came as a web address; `null` when it cannot be fetched. */
export async function fetchImage(src: string, name: string, fetcher: typeof fetch = fetch): Promise<File | null> {
  if (!/^https?:/i.test(src)) return null
  try {
    const response = await fetcher(src, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return null
    const blob = await response.blob()
    return blob.type.startsWith('image/') ? new File([blob], name, { type: blob.type }) : null
  } catch {
    return null
  }
}
