import type { ToolCall } from '../stores/chat'

/**
 * local_dir_search 工具结果的展示态解析。
 *
 * 与 todoTaskCard 相同的安全边界：只识别 FredServer 已落约的结构
 * （items[].citation_id/title/relative_path/content_version/snippet），
 * 引用句柄必须形如 `localdir:`，其余形状一律返回空，绝不猜测。
 */
export interface LocalCitationHit {
  callId: string
  citationId: string
  title: string
  relativePath: string
  contentVersion: string
  snippet: string
}

export function isLocalDirectorySearchCall(call: ToolCall): boolean {
  return !call.isError && call.name === 'local_dir_search'
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function parseJson(value: string | undefined): JsonValue | undefined {
  if (!value) return undefined
  try { return JSON.parse(value) as JsonValue } catch { return undefined }
}

/** ToolCall 的 resultValue/input 是 unknown；展示态解析只接受可收敛的 JSON 形状。 */
function toValue(value: unknown): JsonValue | undefined {
  return value === undefined ? undefined : value as JsonValue
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function parseItems(value: JsonValue | undefined, callId: string): LocalCitationHit[] {
  if (!Array.isArray(value)) return []
  const hits: LocalCitationHit[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (!record) continue
    const citationId = record.citation_id
    const title = record.title
    const snippet = record.snippet
    if (typeof citationId !== 'string' || !citationId.startsWith('localdir:')) continue
    if (typeof title !== 'string' || typeof snippet !== 'string') continue
    const relativePath = record.relative_path
    const contentVersion = record.content_version
    hits.push({
      callId,
      citationId,
      title,
      relativePath: typeof relativePath === 'string' ? relativePath : '',
      contentVersion: typeof contentVersion === 'string' ? contentVersion : '',
      snippet,
    })
  }
  return hits
}

/** 结果优先于输入（服务端执行后的权威列表）；单条结果最多展示 8 条命中。 */
const MAX_HITS_PER_CALL = 8

export function parseLocalCitationHits(call: ToolCall): LocalCitationHit[] {
  if (!isLocalDirectorySearchCall(call)) return []
  const candidates = [parseJson(call.result), toValue(call.resultValue), toValue(call.input)]
  for (const candidate of candidates) {
    const record = asRecord(candidate)
    if (!record) continue
    const hits = parseItems(record.items, call.id)
    if (hits.length > 0) return hits.slice(0, MAX_HITS_PER_CALL)
  }
  return []
}

/** 收集一条回复里所有 local_dir_search 命中，按工具调用顺序拼接。 */
export function collectLocalCitationHits(
  steps: Array<{ kind: string; tool?: ToolCall }> | undefined,
  calls: ToolCall[] | undefined,
): LocalCitationHit[] {
  const seen = new Set<string>()
  const ordered: Array<{ kind: string; tool?: ToolCall }> = [...(steps ?? [])]
  const knownIds = new Set(ordered.flatMap((step) => step.kind === 'tool' && step.tool ? [step.tool.id] : []))
  for (const call of calls ?? []) {
    if (knownIds.has(call.id)) continue
    ordered.push({ kind: 'tool', tool: call })
  }
  const hits: LocalCitationHit[] = []
  for (const step of ordered) {
    if (step.kind !== 'tool' || !step.tool) continue
    for (const hit of parseLocalCitationHits(step.tool)) {
      if (seen.has(hit.citationId)) continue
      seen.add(hit.citationId)
      hits.push(hit)
    }
  }
  return hits
}
