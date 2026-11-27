/**
 * Turns what a paste carries (plain text, HTML and files) into the text to insert plus
 * the files to attach. Pictures and files keep their place in the text as a placeholder that names
 * the attachment, so a message like “看这张 [图片：图1.png] 和这张 [图片：图2.png]” still says
 * which picture is which after the pictures move to the attachment list.
 *
 * The composition itself is DOM-free so it can be unit tested; `htmlToParts` is the only part
 * that needs a browser.
 */

export type PastePart =
  | { kind: 'text'; text: string }
  /** `file` is set when the HTML itself carries the picture's bytes (a data: URL). */
  | { kind: 'image'; name: string; src?: string; file?: File }

export interface ComposedPaste {
  /** Text to insert; empty when the clipboard only held attachments. */
  text: string
  /** Files to attach, renamed so every placeholder points at exactly one attachment. */
  files: File[]
  /**
   * Pictures whose bytes are not on the clipboard: a web address (web pages), a private reference
   * such as Feishu's `native-resource://…`, or a sandboxed temp file (WPS/Word, whose pictures the
   * caller may still recover from the clipboard RTF). They are not downloaded and get no
   * placeholder; only the text is pasted and the caller tells the user.
   */
  unavailable: number
}

/** Files carried by a paste. */
export function filesOf(data: DataTransfer | null | undefined): File[] {
  if (!data) return []
  if (data.files && data.files.length > 0) return Array.from(data.files)
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
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

function baseName(value: string): string {
  return value.split(/[\\/]+/u).filter(Boolean).pop() ?? value
}

/**
 * Finder (and most file managers) put the copied files' names on the clipboard as plain text next
 * to the files themselves. That text is not something the user wrote, so it must not be pasted.
 * Any other text next to a file IS the user's, and is pasted along with the attachment.
 *
 * Takes names or full paths, so the by-path paste route judges the text the same way.
 */
export function isJustFileNames(plain: string, names: readonly string[]): boolean {
  const lines = plain.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0 || names.length === 0) return false
  // macOS 文件名常是分解形式（NFD），文字可能是组合形式（NFC），比较前统一。
  const known = new Set(names.map((name) => baseName(name).normalize('NFC')))
  return lines
    .map((line) => line.normalize('NFC'))
    .every((line) => known.has(line) || known.has(baseName(line)))
}

export function composePaste(input: { plain: string; parts: PastePart[]; files: File[] }): ComposedPaste {
  const { plain, parts, files } = input
  const hasHtmlImage = parts.some((part) => part.kind === 'image')
  if (files.length === 0 && !hasHtmlImage) return { text: plain, files: [], unavailable: 0 }
  // 纯图片 / 访达复制的文件：作附件。
  if (!hasHtmlImage && (!plain.trim() || isJustFileNames(plain, files.map((file) => file.name)))) {
    return { text: '', files: uniqueFiles(files), unavailable: 0 }
  }
  // 有文字、富文本里没有图片、只另带一张图片（Excel/Numbers 复制表格会顺带一张表格截图）：
  // 图片不是内容，只贴文字。其他文件、多个文件是用户要带的内容，走下面照常作附件。
  if (!hasHtmlImage && files.length === 1 && files[0].type.startsWith('image/')) {
    return { text: plain, files: [], unavailable: 0 }
  }

  const taken = new Set<string>()
  const attachments: File[] = []
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
  let dropped = false
  // 富文本里没有图片时没有可定位的位置：原样用纯文本，附件占位排在后面。
  for (const part of hasHtmlImage ? parts : [{ kind: 'text', text: plain } as const]) {
    if (part.kind === 'text') {
      // 去掉一张拿不到的图后，两侧的空格不要叠成两个。
      text += dropped && /\s$/.test(text) ? part.text.replace(/^[ \t]+/, '') : part.text
      dropped = false
      continue
    }
    const file = part.file ?? takeSpareImage()
    if (file) {
      text += attach(file)
    } else {
      unavailable += 1
      dropped = true
    }
  }
  // Files whose place in the text is unknown go last.
  const rest = spare.map(attach)
  text = tidy(text)
  if (rest.length > 0) text = text ? `${text}\n${rest.join('\n')}` : rest.join('\n')

  const words = text.replace(/\[(?:图片|文件)：[^\]]*\]/g, '').trim()
  return { text: words ? text : '', files: attachments, unavailable }
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
