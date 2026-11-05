/**
 * Links an employee writes to files it produced: `file:///…`, `computer:///…`, or a bare absolute path.
 * react-markdown drops every scheme outside its allow list, which left these links with an empty href.
 *
 * The path in such a link belongs to whichever machine runs the Agent, so it is never opened directly.
 * It is only used to find the matching generated file of the conversation.
 */
const SCHEME_PATH = /^(?:file|computer):\/\//i
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/

/** True for URLs that should survive markdown sanitising and be handled as local file links. */
export function isLocalFileUrl(url: string): boolean {
  const value = url.trim()
  return SCHEME_PATH.test(value) || WINDOWS_DRIVE.test(value) || (value.startsWith('/') && !value.startsWith('//'))
}

function decode(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

/** Absolute path named by a local file link, or null when `href` is not one. */
export function localPathFromHref(href: string | undefined): string | null {
  const value = href?.trim()
  if (!value || !isLocalFileUrl(value)) return null
  if (WINDOWS_DRIVE.test(value)) return value
  let path = value.replace(SCHEME_PATH, '')
  if (SCHEME_PATH.test(value)) path = path.replace(/^localhost(?=\/)/i, '')
  path = decode(path)
  // `file:///C:/Users/x` carries the drive behind a leading slash.
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1)
  return path.startsWith('/') || WINDOWS_DRIVE.test(path) ? path : null
}

export function pathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

/** How many trailing folder/file names `artifactPath` shares with the link path. */
function sharedTail(linkSegments: readonly string[], artifactPath: string | null | undefined): number {
  const segments = (artifactPath ?? '').split('/').filter(Boolean)
  let shared = 0
  while (shared < segments.length && shared < linkSegments.length
    && segments[segments.length - 1 - shared] === linkSegments[linkSegments.length - 1 - shared]) shared += 1
  return shared
}

/**
 * Generated file whose name equals the file name in `path`. When several share that name
 * (`game/README.md`, `tool/README.md`), the one whose recorded folder matches the link wins;
 * otherwise the newest.
 */
export function pickArtifactForPath<T extends { filename: string; created_at: string; path?: string | null }>(
  files: readonly T[],
  path: string,
): T | null {
  const name = pathBasename(path)
  if (!name) return null
  const exact = files.filter(file => file.filename === name)
  const matches = exact.length > 0 ? exact : files.filter(file => file.filename.toLowerCase() === name.toLowerCase())
  const linkSegments = path.split(/[\\/]/).filter(Boolean)
  return [...matches].sort((a, b) => sharedTail(linkSegments, b.path ?? b.filename) - sharedTail(linkSegments, a.path ?? a.filename)
    || b.created_at.localeCompare(a.created_at))[0] ?? null
}
