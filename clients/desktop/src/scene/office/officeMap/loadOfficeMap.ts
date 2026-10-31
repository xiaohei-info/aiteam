/**
 * 地图与贴图加载：读取 office-map/v1.1 JSON，并预载它引用的全部贴图。
 * 贴图 URL 相对 `public/` 解析（与 AITeam 其他办公室资源一致）。
 */
import 'pixi.js/unsafe-eval'
import { invoke } from '@tauri-apps/api/core'
import { Assets, Texture } from 'pixi.js'
import type { OfficeMap } from './types'

function isTauriDesktop(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  )
}

function isPackagedTauriProtocol(): boolean {
  return (
    isTauriDesktop() &&
    typeof window !== 'undefined' &&
    window.location.protocol !== 'http:' &&
    window.location.protocol !== 'https:'
  )
}

// Tauri 生产包 CSP 的 connect-src 不允许 fetch('data:...')，
// 关闭 worker 与 createImageBitmap(fetch) 路径，改走 HTMLImageElement（受 img-src 控制，已允许 data: / blob: / 'self'）。
Assets.setPreferences({
  preferWorkers: false,
  preferCreateImageBitmap: false,
})

export interface LoadedOfficeMap {
  map: OfficeMap
  textures: Map<string, Texture>
  /** 没有加载成功的贴图 src，便于上层提示 */
  missing: string[]
}

export interface SharedOfficeMapEntry {
  file: string
  name: string
  updatedAt: string
  width: number
  height: number
  elements: number
  seats: number
}

export interface SharedOfficeMapList {
  activeFile: string
  updatedAt: string
  files: SharedOfficeMapEntry[]
}

const DEFAULT_MAP_FILE = 'office-10-person.json'

export function buildOfficeEditorUrl(file = DEFAULT_MAP_FILE): string {
  const safeFile = (file || DEFAULT_MAP_FILE).trim() || DEFAULT_MAP_FILE
  return `/office-editor/?file=${encodeURIComponent(safeFile)}`
}

function normalizeSharedMapList(data: Partial<SharedOfficeMapList> | null | undefined): SharedOfficeMapList | null {
  if (!data || typeof data.activeFile !== 'string' || !Array.isArray(data.files)) return null
  return {
    activeFile: data.activeFile,
    updatedAt: String(data.updatedAt ?? ''),
    files: data.files.map((item) => ({
      ...item,
      updatedAt: String(item.updatedAt ?? ''),
    })),
  }
}

export async function fetchSharedOfficeMaps(): Promise<SharedOfficeMapList> {
  if (isPackagedTauriProtocol()) {
    try {
      const result = await invoke<Partial<SharedOfficeMapList>>('list_office_maps')
      const normalized = normalizeSharedMapList(result)
      if (normalized) return normalized
    } catch {
      // Fall through to static manifest fallback
    }
  }

  try {
    const response = await fetch('/__office-editor/api/maps', { cache: 'no-store' })
    const contentType = response.headers.get('content-type') || ''
    if (response.ok && contentType.includes('application/json')) {
      const data = (await response.json()) as Partial<SharedOfficeMapList>
      const normalized = normalizeSharedMapList(data)
      if (normalized) return normalized
    }
  } catch {
    // Fallback below
  }

  if (isTauriDesktop()) {
    try {
      const result = await invoke<Partial<SharedOfficeMapList>>('list_office_maps')
      const normalized = normalizeSharedMapList(result)
      if (normalized) return normalized
    } catch {
      // Fallback to static manifest.json below
    }
  }

  try {
    const response = await fetch('/assets/office/map/manifest.json', { cache: 'no-store' })
    if (response.ok) {
      const manifest = (await response.json()) as {
        activeMap?: string
        updatedAt?: string | number
        generatedAt?: string
        elements?: number
        seats?: number
      }
      const activeFile = manifest.activeMap || DEFAULT_MAP_FILE
      const updatedAt = String(manifest.updatedAt ?? manifest.generatedAt ?? '')
      return {
        activeFile,
        updatedAt,
        files: [
          {
            file: activeFile,
            name: activeFile.replace(/\.json$/i, ''),
            updatedAt,
            width: 1600,
            height: 1200,
            elements: manifest.elements ?? 0,
            seats: manifest.seats ?? 0,
          },
        ],
      }
    }
  } catch {
    // Ignore and return default
  }

  return {
    activeFile: DEFAULT_MAP_FILE,
    updatedAt: '',
    files: [],
  }
}

export async function setActiveOfficeMap(file: string): Promise<void> {
  if (isPackagedTauriProtocol()) {
    try {
      await invoke('set_active_office_map_cmd', { file })
      return
    } catch {
      // Best-effort sync
    }
  }
  try {
    const response = await fetch('/__office-editor/api/active-map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    })
    const contentType = response.headers.get('content-type') || ''
    if (response.ok && contentType.includes('application/json')) return
  } catch {
    // Fallback to Tauri invoke if in desktop mode
  }
  if (isTauriDesktop()) {
    try {
      await invoke('set_active_office_map_cmd', { file })
    } catch {
      // Best-effort sync
    }
  }
}

export async function openOfficeMapEditor(file = DEFAULT_MAP_FILE): Promise<string> {
  const editorUrl = buildOfficeEditorUrl(file)
  if (isPackagedTauriProtocol()) {
    try {
      const data = await invoke<{ url?: string }>('open_office_map_editor', { file })
      return data?.url || editorUrl
    } catch (error) {
      console.warn('[office-map] Tauri 启动办公室编辑器失败', error)
      return editorUrl
    }
  }
  try {
    const response = await fetch('/__office-editor/api/open-browser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file,
        origin: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:1420',
      }),
    })
    const contentType = response.headers.get('content-type') || ''
    if (response.ok && contentType.includes('application/json')) {
      const data = (await response.json()) as { url?: string }
      return data.url || editorUrl
    }
  } catch {
    // Fallback to Tauri invoke below
  }
  if (isTauriDesktop()) {
    try {
      const data = await invoke<{ url?: string }>('open_office_map_editor', { file })
      return data?.url || editorUrl
    } catch (error) {
      console.warn('[office-map] Tauri 启动办公室编辑器失败', error)
    }
  }
  return editorUrl
}

function resolveAssetUrl(rel: string): string {
  if (/^[a-z]+:\/\//i.test(rel)) return rel
  if (rel.startsWith('data:') || rel.startsWith('blob:')) return rel
  // 自动兼容编辑工具直接导出的原始路径（无需手动修改 JSON 或跑同步脚本）
  const normalized = rel
    .replace(/^assets\/styles\/topdown-soft\//, 'assets/office/topdown/')
    .replace(/^assets\/aifred\/office\//, 'assets/office/')
    .replace(/^\/+/, '')
  const base = typeof document !== 'undefined' ? document.baseURI : '/'
  const originRoot = base.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]+\/)/i)?.[1]
  if (originRoot) return `${originRoot}${normalized}`
  return new URL(normalized, base).href
}

function isOfficeMap(value: unknown): value is OfficeMap {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<OfficeMap>
  return (
    typeof candidate.schema === 'string' &&
    candidate.schema.startsWith('office-map/') &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    Array.isArray(candidate.assets) &&
    Array.isArray(candidate.elements) &&
    Array.isArray(candidate.zones)
  )
}

function extractSharedMapFileName(url: string): string | null {
  const withoutQuery = url.split('?')[0].split('#')[0]
  const match = withoutQuery.match(/(?:^|\/)assets\/office\/map\/([^/]+\.json)$/i)
  if (!match) return null
  const file = decodeURIComponent(match[1])
  if (file.toLowerCase() === 'manifest.json') return null
  return file
}

export async function fetchOfficeMap(url: string): Promise<OfficeMap> {
  const sharedMapFile = extractSharedMapFileName(url)
  if (sharedMapFile && isPackagedTauriProtocol()) {
    try {
      const result = await invoke<{ file?: string; map?: unknown }>('read_office_map', {
        file: sharedMapFile,
      })
      if (result && isOfficeMap(result.map)) {
        return result.map
      }
    } catch {
      // Fall back to static asset fetch below
    }
  }

  const response = await fetch(resolveAssetUrl(url))
  if (!response.ok) {
    if (sharedMapFile && isTauriDesktop()) {
      const result = await invoke<{ file?: string; map?: unknown }>('read_office_map', {
        file: sharedMapFile,
      })
      if (result && isOfficeMap(result.map)) {
        return result.map
      }
    }
    throw new Error(`地图加载失败 ${url} · HTTP ${response.status}`)
  }
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error(`地图 JSON 解析失败（不是合法 JSON）：${url}`)
  }
  if (!isOfficeMap(data)) throw new Error('不是识别得了的 office-map 配置（缺少 schema/assets/elements/zones）')
  return data
}

/** 预载地图引用的所有贴图；单个失败只记录不阻断整场景 */
export async function loadOfficeMapTextures(map: OfficeMap): Promise<{ textures: Map<string, Texture>; missing: string[] }> {
  const textures = new Map<string, Texture>()
  const missing: string[] = []

  const tasks: Promise<void>[] = []
  map.assets.forEach((asset, index) => {
    tasks.push(
      (async () => {
        const alias = `office-map-${map.id}-${index}`
        try {
          if (!Assets.resolver.hasKey(alias)) Assets.add({ alias, src: resolveAssetUrl(asset.src) })
          const texture = (await Assets.load(alias)) as Texture
          if (texture?.source) {
            texture.source.scaleMode = 'linear'
            textures.set(asset.src, texture)
          } else {
            missing.push(asset.src)
          }
        } catch (error) {
          console.warn(`[office-map] 贴图加载失败 ${asset.src}`, error)
          missing.push(asset.src)
        }
      })(),
    )
  })
  await Promise.all(tasks)

  return { textures, missing }
}

export async function loadOfficeMap(url: string): Promise<LoadedOfficeMap> {
  const map = await fetchOfficeMap(url)
  const { textures, missing } = await loadOfficeMapTextures(map)
  return { map, textures, missing }
}
