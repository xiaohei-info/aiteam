/**
 * 办公室场景资源加载器
 *
 * - 底图（多张，按注册表懒加载）
 * - 工位桌子（多张）
 * - 员工 Spine 骨架（chibi-stickers）
 *
 * 加载失败会退化到"矢量占位"，让页面仍然可用。
 */

import 'pixi.js/unsafe-eval'
import '@esotericsoftware/spine-pixi-v8'
import { Assets, type Texture } from 'pixi.js'
import {
  OFFICE_BACKGROUNDS,
  type OfficeBackground,
} from '@/config/office/backgrounds'
import { DESK_ASSETS, type DeskAsset } from '@/config/office/desks'
import { CHIBI_SPINE_ASSETS } from '@/config/office/characters'

// Tauri 生产包 CSP 的 connect-src 不放行 data:，而 img-src 放行 'self' / data: / blob: / asset:；
// 关闭 worker 与 createImageBitmap(fetch) 路径，让纹理统一走 HTMLImageElement。
Assets.setPreferences({
  preferWorkers: false,
  preferCreateImageBitmap: false,
})

/**
 * 把相对路径解析为完整 URL。
 *
 * Tauri 使用的 `tauri://localhost` 不是 URL 标准的"特殊 scheme"，
 * PixiJS Assets 内部会对 `/foo` 做 `new URL('/foo', base)` —— 但对于非特殊 scheme
 * `/foo` 会被解析为 `tauri://foo`（把首段吃成 host），导致资源 404 并返回 index.html。
 * 这里显式取出协议+主机根前缀拼出完整绝对 URL，避免子路由下相对路径偏移。
 */
function resolveAssetUrl(rel: string): string {
  if (/^[a-z]+:\/\//i.test(rel)) return rel
  if (rel.startsWith('data:') || rel.startsWith('blob:')) return rel
  const cleanRel = rel.replace(/^\/+/, '')
  const base = typeof document !== 'undefined' ? document.baseURI : '/'
  const originRoot = base.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]+\/)/i)?.[1]
  if (originRoot) return `${originRoot}${cleanRel}`
  return new URL(cleanRel, base).href
}

const bgTextures = new Map<string, Texture>()
const deskTextures = new Map<string, Texture>()

/**
 * 参考项目 ai-office-react 使用的桌椅 PNG（俯视 3/4 视角）。
 * 桌子与椅子分别是独立贴图，运行时叠放：椅子 zIndex 高于桌子，
 * 员工 Spine 位于两者之间，形成半身遮挡的座位效果。
 *
 * 电脑分为两层：
 * 1. 电脑底图（office_computer_bg.png）：显示器外框 + 底座，静态PNG
 * 2. 屏幕内容（screen-*.gif）：4个工作状态的gif，叠加在底图上
 */
const DESK_PNG_URL = '/assets/office/desk.png'
const CHAIR_PNG_URL = '/assets/office/chair.png'
const COMPUTER_PNG_URL = '/assets/office/office_computer_bg.png'
const DESK_PNG_ALIAS = 'office-desk-png'
const CHAIR_PNG_ALIAS = 'office-chair-png'
const COMPUTER_PNG_ALIAS = 'office-computer-png'

let deskPngTexture: Texture | null = null
let chairPngTexture: Texture | null = null
let computerPngTexture: Texture | null = null

let spineSkeletonAlias = ''
let spineAtlasAlias = ''
let spineLoaded = false

async function loadTexture(alias: string, src: string): Promise<Texture | null> {
  const url = resolveAssetUrl(src)
  try {
    if (!Assets.resolver.hasKey(alias)) {
      Assets.add({ alias, src: url })
    }
    const tex = (await Assets.load(alias)) as Texture
    if (tex?.source) {
      tex.source.scaleMode = 'linear'
      return tex
    }
    return null
  } catch (err) {
    console.warn(`[office-assets] 纹理加载失败 alias=${alias}`, err)
    return null
  }
}

async function loadBackground(bg: OfficeBackground): Promise<void> {
  if (bgTextures.has(bg.id)) return
  const tex = await loadTexture(`office-bg-${bg.id}`, bg.src)
  if (tex) bgTextures.set(bg.id, tex)
}

async function loadDesk(desk: DeskAsset): Promise<void> {
  if (deskTextures.has(desk.id)) return
  const tex = await loadTexture(`office-desk-${desk.id}`, desk.src)
  if (tex) deskTextures.set(desk.id, tex)
}

async function loadDeskChairPng(): Promise<void> {
  if (!deskPngTexture) {
    deskPngTexture = await loadTexture(DESK_PNG_ALIAS, DESK_PNG_URL)
  }
  if (!chairPngTexture) {
    chairPngTexture = await loadTexture(CHAIR_PNG_ALIAS, CHAIR_PNG_URL)
  }
  if (!computerPngTexture) {
    computerPngTexture = await loadTexture(COMPUTER_PNG_ALIAS, COMPUTER_PNG_URL)
  }
}

async function loadSpine(): Promise<void> {
  if (spineLoaded) return
  const skAlias = `${CHIBI_SPINE_ASSETS.id}-skeleton`
  const atAlias = `${CHIBI_SPINE_ASSETS.id}-atlas`
  try {
    if (!Assets.resolver.hasKey(skAlias)) {
      Assets.add({ alias: skAlias, src: resolveAssetUrl(CHIBI_SPINE_ASSETS.skeleton) })
    }
    if (!Assets.resolver.hasKey(atAlias)) {
      Assets.add({ alias: atAlias, src: resolveAssetUrl(CHIBI_SPINE_ASSETS.atlas) })
    }
    await Assets.load([skAlias, atAlias])
    spineSkeletonAlias = skAlias
    spineAtlasAlias = atAlias
    spineLoaded = true
    console.info('[office-assets] Spine 角色资源已加载', CHIBI_SPINE_ASSETS.id)
  } catch (err) {
    console.warn('[office-assets] Spine 角色资源加载失败，员工将使用占位色块', err)
    spineLoaded = false
  }
}

/** 预加载：指定底图 + 全部桌子 + Spine 骨架 */
export async function loadOfficeSceneAssets(
  target: string | number,
): Promise<void> {
  const targetBg =
    typeof target === 'string'
      ? OFFICE_BACKGROUNDS.find((bg) => bg.id === target)
      : OFFICE_BACKGROUNDS.find((bg) => target <= bg.maxAgents) ??
        OFFICE_BACKGROUNDS[OFFICE_BACKGROUNDS.length - 1]

  const tasks: Promise<void>[] = []
  if (targetBg) tasks.push(loadBackground(targetBg))
  for (const desk of DESK_ASSETS) tasks.push(loadDesk(desk))
  tasks.push(loadDeskChairPng())
  tasks.push(loadSpine())

  await Promise.all(tasks)
}

/** 允许后续按需加载其他底图（切换背景时） */
export async function ensureBackgroundLoaded(bgId: string): Promise<Texture | null> {
  if (bgTextures.has(bgId)) return bgTextures.get(bgId) ?? null
  const bg = OFFICE_BACKGROUNDS.find((b) => b.id === bgId)
  if (!bg) return null
  await loadBackground(bg)
  return bgTextures.get(bgId) ?? null
}

export function getBackgroundTexture(bgId: string): Texture | null {
  return bgTextures.get(bgId) ?? null
}

export function getDeskTexture(deskId: string): Texture | null {
  return deskTextures.get(deskId) ?? null
}

export function getDeskPngTexture(): Texture | null {
  return deskPngTexture
}

export function getChairPngTexture(): Texture | null {
  return chairPngTexture
}

export function getComputerPngTexture(): Texture | null {
  return computerPngTexture
}

export function isSpineReady(): boolean {
  return spineLoaded
}

/** 只加载 Spine 骨架/atlas（地图场景不需要底图与桌椅 PNG 时使用） */
export async function ensureOfficeSpine(): Promise<boolean> {
  await loadSpine()
  return spineLoaded
}

export function getSpineSkeletonAlias(): string {
  return spineSkeletonAlias
}

export function getSpineAtlasAlias(): string {
  return spineAtlasAlias
}
