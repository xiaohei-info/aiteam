import { assertSecureApiUrl } from '../../api/urlSecurity.ts'
import { LEGACY_NAS_ID } from './knowledgeService.ts'
import type { KnowledgeSourceConfig, NasConnectionConfig } from './types'

const STORAGE_KEY = 'aifred:knowledge-source-config:v1'

export const EMPTY_KNOWLEDGE_SOURCE_CONFIG: KnowledgeSourceConfig = {
  enterpriseUrl: '',
  enterpriseToken: '',
  nas: [],
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Reads stored config, migrating the legacy single `localUrl`/`localToken` NAS. */
export function parseKnowledgeSourceConfig(raw: unknown): KnowledgeSourceConfig {
  if (!raw || typeof raw !== 'object') return EMPTY_KNOWLEDGE_SOURCE_CONFIG
  const value = raw as Record<string, unknown>
  const nas: NasConnectionConfig[] = Array.isArray(value.nas)
    ? value.nas.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const entry = item as Record<string, unknown>
      const id = text(entry.id)
      const url = text(entry.url)
      return id && url ? [{ id, name: text(entry.name), url, token: text(entry.token) }] : []
    })
    : text(value.localUrl).trim()
      ? [{ id: LEGACY_NAS_ID, name: '', url: text(value.localUrl), token: text(value.localToken) }]
      : []
  return { enterpriseUrl: text(value.enterpriseUrl), enterpriseToken: text(value.enterpriseToken), nas }
}

export function readKnowledgeSourceConfig(): KnowledgeSourceConfig {
  if (typeof window === 'undefined') return EMPTY_KNOWLEDGE_SOURCE_CONFIG
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? parseKnowledgeSourceConfig(JSON.parse(raw)) : EMPTY_KNOWLEDGE_SOURCE_CONFIG
  } catch {
    return EMPTY_KNOWLEDGE_SOURCE_CONFIG
  }
}

export function writeKnowledgeSourceConfig(config: KnowledgeSourceConfig): void {
  if (typeof window === 'undefined') return
  const normalized: KnowledgeSourceConfig = {
    enterpriseUrl: normalizeUrl(config.enterpriseUrl),
    enterpriseToken: config.enterpriseToken.trim(),
    nas: config.nas
      .map((item) => ({ id: item.id, name: item.name.trim(), url: normalizeUrl(item.url), token: item.token.trim() }))
      .filter((item) => item.id && item.url),
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
}

export function normalizeUrl(value: string): string {
  return value.trim().replace(/\/$/u, '')
}

/** URL without the scheme, for display. */
export function displayAddress(url: string): string {
  return normalizeUrl(url).replace(/^https?:\/\//u, '')
}

export function nasDisplayName(nas: Pick<NasConnectionConfig, 'name' | 'url'>): string {
  return nas.name.trim() || displayAddress(nas.url)
}

function sameAddress(left: string, right: string): boolean {
  return normalizeUrl(left).toLowerCase() === normalizeUrl(right).toLowerCase()
}

function createNasId(existing: readonly NasConnectionConfig[]): string {
  for (;;) {
    const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
    const id = `nas-${random.replace(/-/gu, '').slice(0, 8)}`
    if (!existing.some((item) => item.id === id)) return id
  }
}

/**
 * Adds a NAS (no `id`) or updates one, rejecting a second connection to the same
 * address or a repeated name. Editing keeps the id: it fixes the address or token
 * of the same NAS, so its library keys and upload records stay valid.
 */
export function upsertNasConnection(
  config: KnowledgeSourceConfig,
  draft: { id?: string; name: string; url: string; token: string },
): { config: KnowledgeSourceConfig; id: string } {
  const url = normalizeUrl(draft.url)
  const name = draft.name.trim()
  const previous = draft.id ? config.nas.find((item) => item.id === draft.id) : undefined
  if (draft.id && !previous) throw new Error('这台 NAS 已断开连接，请重新添加。')
  const others = config.nas.filter((item) => item !== previous)
  const sameUrl = others.find((item) => sameAddress(item.url, url))
  if (sameUrl) throw new Error(`这个地址已连接为「${nasDisplayName(sameUrl)}」，无需重复添加。`)
  if (name && others.some((item) => item.name.trim() === name)) throw new Error(`已有名为「${name}」的 NAS，请换个名称。`)
  const id = previous ? previous.id : createNasId(config.nas)
  const entry: NasConnectionConfig = { id, name, url, token: draft.token.trim() }
  const nas = previous ? config.nas.map((item) => (item === previous ? entry : item)) : [...config.nas, entry]
  return { config: { ...config, nas }, id }
}

export function validateKnowledgeSourceUrl(value: string): string | null {
  const url = normalizeUrl(value)
  if (!url) return null
  try {
    assertSecureApiUrl(url, '知识库服务')
    return null
  } catch (error) {
    return error instanceof Error ? error.message : '知识库服务地址不符合安全策略。'
  }
}
