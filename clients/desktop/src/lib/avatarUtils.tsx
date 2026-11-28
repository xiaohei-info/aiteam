import { useEffect, useState, type ReactNode } from 'react'
import { Img } from 'react-image'
import { BACKEND_BASE_URL } from '../api/backend/config'
import { backendApi } from '../api/backend'
import { resolveAvatarUrl } from './avatarUrl'

/**
 * AI员工头像工具函数
 *
 * 规则：
 * 1. 如果员工有自定义头像URL，则使用该URL
 * 2. 否则显示员工名称的第一个字
 */

/**
 * 获取AI员工的头像显示内容
 * @param displayName 员工显示名称
 * @param avatarUrl 员工头像URL或服务端相对路径（可选）
 * @returns 头像内容：完整URL字符串或首字符
 */
export function getEmployeeAvatar(displayName: string, avatarUrl?: string | null): string {
  const resolvedAvatarUrl = resolveAvatarUrl(avatarUrl, BACKEND_BASE_URL)
  if (resolvedAvatarUrl) {
    return resolvedAvatarUrl
  }
  return getAvatarFallback(displayName)
}

/** Return a deterministic text fallback without rendering an empty avatar. */
export function getAvatarFallback(displayName: string): string {
  return displayName.trim().slice(0, 1).toUpperCase() || '?'
}

/**
 * 判断头像内容是否为URL
 * @param avatar 头像内容
 * @returns 是否为URL
 */
export function isAvatarUrl(avatar: string): boolean {
  return /^(?:https?:|data:|blob:|\/\/)/i.test(avatar)
}

interface AvatarImageProps {
  src: string
  alt?: string
  fallback?: ReactNode
}

type ProtectedAvatarTarget = { kind: 'employee' | 'template'; id: string; version: string | null }

const PROTECTED_AVATAR_PATHS: ReadonlyArray<[ProtectedAvatarTarget['kind'], RegExp]> = [
  ['employee', /^\/api\/agent\/employees\/([^/]+)\/avatar\/content$/u],
  ['template', /^\/api\/agent\/marketplace\/templates\/([^/]+)\/avatar\/content$/u],
]

/**
 * 受保护头像只可能是本机 Agent 的员工头像或人才市场模板头像（都需 Bearer）；
 * 解析出 ID 与版本（`?v=`）后交由文档契约内的客户端请求，不经任意 URL 直连。
 */
function protectedAvatarTarget(src: string): ProtectedAvatarTarget | null {
  try {
    const url = new URL(src)
    const backend = new URL(BACKEND_BASE_URL)
    if (url.origin !== backend.origin) return null
    for (const [kind, pattern] of PROTECTED_AVATAR_PATHS) {
      const match = pattern.exec(url.pathname)
      if (match) return { kind, id: decodeURIComponent(match[1]), version: url.searchParams.get('v') }
    }
    return null
  } catch {
    return null
  }
}

// 会话级复用受保护头像的 objectURL：
// 1. 同一员工头像在列表/群头像/详情面板反复挂载时只发一次请求（并发自动合并）；
// 2. 传给 <Img> 的 blob URL 恒定不变，命中 react-image 内部 cache 且避免随机 blob URL 堆积泄漏；
// 3. 登录凭证变化时自动 revoke 旧 objectURL 并重建。
let cachedAvatarToken: string | null = null
const protectedAvatarUrlCache = new Map<string, Promise<string>>()
const allocatedObjectUrls: string[] = []

function loadProtectedAvatarObjectUrl(
  src: string,
  target: ProtectedAvatarTarget,
  token: string,
): Promise<string> {
  if (cachedAvatarToken !== token) {
    cachedAvatarToken = token
    protectedAvatarUrlCache.clear()
    for (const url of allocatedObjectUrls.splice(0)) {
      URL.revokeObjectURL(url)
    }
  }
  const existing = protectedAvatarUrlCache.get(src)
  if (existing) return existing

  const task = (async () => {
    const blob = target.kind === 'employee'
      ? await backendApi.getEmployeeAvatarContent(target.id, target.version)
      : await backendApi.getMarketplaceTemplateAvatarContent(target.id, target.version)
    if (cachedAvatarToken !== token) {
      throw new Error('avatar token changed during request')
    }
    const objectUrl = URL.createObjectURL(blob)
    allocatedObjectUrls.push(objectUrl)
    return objectUrl
  })().catch((err) => {
    protectedAvatarUrlCache.delete(src)
    throw err
  })

  protectedAvatarUrlCache.set(src, task)
  return task
}

function AvatarImage({ src, alt = '', fallback = '?' }: AvatarImageProps) {
  const target = protectedAvatarTarget(src)
  const targetKind = target?.kind ?? null
  const targetId = target?.id ?? null
  const avatarVersion = target?.version ?? null
  const protectedUrl = targetId !== null
  const [displaySrc, setDisplaySrc] = useState<string | null>(() => protectedUrl ? null : src)

  useEffect(() => {
    let disposed = false

    // CDN/data/blob URLs can be loaded by the browser directly. Local Agent
    // avatar content is an authenticated binary endpoint, so read it through
    // the documented service client and reuse the session-cached object URL.
    if (!targetId || !targetKind) {
      setDisplaySrc(src)
      return () => { disposed = true }
    }

    const token = (globalThis as { __agentToken?: string | null }).__agentToken
    if (!token) {
      setDisplaySrc(src)
      return () => { disposed = true }
    }

    setDisplaySrc(null)
    void loadProtectedAvatarObjectUrl(src, { kind: targetKind, id: targetId, version: avatarVersion }, token)
      .then((objectUrl) => {
        if (!disposed) setDisplaySrc(objectUrl)
      })
      .catch(() => {
        if (!disposed) setDisplaySrc(null)
      })

    return () => {
      disposed = true
    }
  }, [avatarVersion, targetId, targetKind, src])

  if (!displaySrc) return <>{fallback}</>

  return (
    <Img
      src={displaySrc}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      loader={<>{fallback}</>}
      unloader={<>{fallback}</>}
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        borderRadius: 'inherit',
      }}
    />
  )
}

/**
 * 渲染头像为ReactNode
 * @param avatar 头像内容（URL或字符）
 * @returns 可渲染的内容
 */
export function renderAvatar(avatar: string, fallback: ReactNode = '?'): ReactNode {
  if (isAvatarUrl(avatar)) {
    // Remount on URL changes so a previously failed request cannot poison a
    // newly uploaded/re-synced avatar.
    return <AvatarImage key={avatar} src={avatar} fallback={fallback} />
  }
  return avatar
}
