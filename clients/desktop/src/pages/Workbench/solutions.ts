/**
 * 工作台：汇总 AI 员工在不同 Agent 对话中生成的方案文件，只展示每份文件的最终版本。
 *
 * - Fred：本机 Agent 会话的产物（artifact），按 AI 员工归属；同名文件只保留最新版本。
 * - Claude Code / Claude 桌面版 / Codex / TRAE CLI / Qoder CLI / WorkBuddy：桌面宿主只读解析本机会话记录中的
 *   文件写入（见 src-tauri/src/agent_solutions.rs），只保留文档类文件，不含对话内容、代码改动与工具输出。
 * - DeepSeek 不是独立客户端，而是按模型汇总：任一平台上由 DeepSeek 模型写出的方案都算，与来源重复计数。
 *
 * 只有生成过方案文件的对话才会出现在工作台。本文件只放纯函数，便于 node 测试。
 */
import type { ConversationMetadata, ExpertProjection, LocalFileMetadata } from '../../api/agent/types'

/** 桌面宿主读取的本机 Agent，与 Rust 侧 AgentSource 的序列化值一致。 */
export type LocalSolutionSource = 'claude' | 'claude_desktop' | 'codex' | 'trae' | 'qoder' | 'workbuddy'

export type SolutionSource = 'fred' | LocalSolutionSource

export const LOCAL_SOLUTION_SOURCES: LocalSolutionSource[] = ['claude', 'claude_desktop', 'codex', 'trae', 'qoder', 'workbuddy']

export const SOLUTION_SOURCES: SolutionSource[] = ['fred', ...LOCAL_SOLUTION_SOURCES]

export const SOURCE_LABELS: Record<SolutionSource, string> = {
  fred: 'Fred',
  claude: 'Claude Code',
  claude_desktop: 'Claude 桌面版',
  codex: 'Codex',
  trae: 'TRAE',
  qoder: 'Qoder',
  workbuddy: 'WorkBuddy',
}

/** 按模型汇总的筛选项，不对应任何客户端。 */
export const DEEPSEEK = 'deepseek'

export type SourceFilter = SolutionSource | typeof DEEPSEEK | 'all'

export const FILTER_LABELS: Record<Exclude<SourceFilter, 'all'>, string> = { ...SOURCE_LABELS, deepseek: 'DeepSeek' }

const DEEPSEEK_MODEL = /deepseek/i

/** document = Office / PDF：只能用系统默认应用打开，不在页面内预览。 */
export type FileFormat = 'markdown' | 'text' | 'html' | 'csv' | 'svg' | 'document'

export interface SolutionFile {
  id: string
  name: string
  /** 本机路径（家目录显示为 ~）；Fred 产物没有本机路径。 */
  path: string | null
  format: FileFormat
  /** 对话中新建的文件，还是修改了已有文件。Fred 产物都是新建。 */
  kind: 'created' | 'updated'
  /** 原文件是否还在；不在时内容由会话记录还原。 */
  exists: boolean
  changedAt: number | null
  /** 最后一次修改该文件时的用户需求。 */
  task: string | null
  /** 最后一次修改该文件的模型；Fred 产物不记录。 */
  model: string | null
  mimeType: string | null
}

export interface SolutionSummary {
  key: string
  source: SolutionSource
  id: string
  title: string
  employeeName: string
  employeeAvatarUrl: string | null
  workspace: string | null
  /** 会话最后使用的模型。 */
  model: string | null
  /** 写出这些文件的模型，缺失时取会话模型；DeepSeek 筛选依据它。 */
  models: string[]
  createdAt: number | null
  updatedAt: number | null
  isGroup: boolean
  /** 最近修改的在前，至少一份。 */
  files: SolutionFile[]
}

export interface SolutionFileContent {
  /** Office / PDF 为 null。 */
  text: string | null
  /** 原文件已删除或移动，内容由会话记录还原。 */
  fromRecord: boolean
}

export type SourceStatus = 'ready' | 'missing' | 'desktop_only' | 'error'

export interface SourceState {
  source: SolutionSource
  status: SourceStatus
  count: number
  truncated: boolean
  message?: string
}

export const solutionKey = (source: SolutionSource, id: string) => `${source}:${id}`

// -------------------- 文件类型 --------------------

const FORMAT_BY_EXTENSION: Record<string, FileFormat> = {
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  html: 'html',
  htm: 'html',
  csv: 'csv',
  svg: 'svg',
  docx: 'document',
  doc: 'document',
  pptx: 'document',
  ppt: 'document',
  xlsx: 'document',
  xls: 'document',
  pdf: 'document',
}

/** 与代码放在一起的说明文件不算方案；与 Rust 侧 EXCLUDED_STEMS 保持一致。 */
const EXCLUDED_STEMS = new Set([
  'readme', 'agents', 'claude', 'gemini', 'changelog', 'license', 'contributing', 'code_of_conduct', 'security', 'skill',
])

function splitName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0
    ? { stem: name.slice(0, dot).toLowerCase(), extension: name.slice(dot + 1).toLowerCase() }
    : { stem: name.toLowerCase(), extension: '' }
}

/** 方案文件的格式；代码、图片、隐藏文件和说明文件返回 null。 */
export function solutionFileFormat(name: string): FileFormat | null {
  if (!name || name.startsWith('.')) return null
  const { stem, extension } = splitName(name)
  if (EXCLUDED_STEMS.has(stem)) return null
  return FORMAT_BY_EXTENSION[extension] ?? null
}

const DOCUMENT_LABELS: Record<string, string> = {
  docx: 'Word', doc: 'Word', pptx: 'PPT', ppt: 'PPT', xlsx: 'Excel', xls: 'Excel', pdf: 'PDF',
}

const FORMAT_LABELS: Record<Exclude<FileFormat, 'document'>, string> = {
  markdown: 'Markdown', text: '文本', html: 'HTML', csv: 'CSV', svg: 'SVG',
}

export function fileTypeLabel(file: Pick<SolutionFile, 'name' | 'format'>): string {
  if (file.format !== 'document') return FORMAT_LABELS[file.format]
  return DOCUMENT_LABELS[splitName(file.name).extension] ?? '文档'
}

// -------------------- 本机 Agent（Tauri 命令返回值） --------------------

export interface LocalSolutionFileWire {
  id: string
  name: string
  path: string
  format: FileFormat
  kind: 'created' | 'updated'
  exists: boolean
  changed_at: number | null
  task: string | null
  model: string | null
}

export interface LocalSolutionSummaryWire {
  source: LocalSolutionSource
  id: string
  title: string
  employee_name: string
  workspace: string | null
  model: string | null
  models: string[]
  created_at: number | null
  updated_at: number | null
  files: LocalSolutionFileWire[]
}

export interface LocalSolutionListWire {
  sources: { source: LocalSolutionSource; available: boolean; solution_count: number; truncated: boolean }[]
  solutions: LocalSolutionSummaryWire[]
}

export interface LocalSolutionFileContentWire {
  name: string
  path: string
  format: FileFormat
  origin: 'disk' | 'record'
  content: string | null
}

export function fromLocalSummary(wire: LocalSolutionSummaryWire): SolutionSummary {
  return {
    key: solutionKey(wire.source, wire.id),
    source: wire.source,
    id: wire.id,
    title: wire.title,
    employeeName: wire.employee_name,
    employeeAvatarUrl: null,
    workspace: wire.workspace,
    model: wire.model,
    models: wire.models,
    createdAt: wire.created_at,
    updatedAt: wire.updated_at,
    isGroup: false,
    files: wire.files.map(file => ({
      id: file.id,
      name: file.name,
      path: file.path,
      format: file.format,
      kind: file.kind,
      exists: file.exists,
      changedAt: file.changed_at,
      task: file.task,
      model: file.model,
      mimeType: null,
    })),
  }
}

export function fromLocalFileContent(wire: LocalSolutionFileContentWire): SolutionFileContent {
  return { text: wire.content, fromRecord: wire.origin === 'record' }
}

export function localSourceStates(list: LocalSolutionListWire): SourceState[] {
  return list.sources.map(item => ({
    source: item.source,
    status: item.available ? 'ready' : 'missing',
    count: item.solution_count,
    truncated: item.truncated,
  }))
}

const LOCAL_ERROR_MESSAGES: Record<string, string> = {
  home_unavailable: '无法确定当前用户目录',
  invalid_source: '不支持的 Agent 来源',
  invalid_id: '会话标识无效',
  invalid_file_id: '文件标识无效',
  solution_not_found: '该会话记录已不存在或已被移动',
  file_not_found: '该文件已不在会话记录中',
  file_missing: '原文件已删除或移动，且无法从会话记录还原',
  file_too_large: '文件超过 2 MB，请用默认应用打开',
  file_unreadable: '没有权限读取该文件',
  open_failed: '无法用系统应用打开该文件',
  scan_failed: '读取本机 Agent 记录失败',
}

export function localErrorMessage(error: unknown): string {
  const code = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  return LOCAL_ERROR_MESSAGES[code] ?? '读取本机 Agent 记录失败'
}

// -------------------- Fred --------------------

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

/** 新建后从未对话的会话不会有产物，不必请求其文件列表。 */
export function hasConversationActivity(conversation: ConversationMetadata): boolean {
  const preview = typeof conversation.last_preview === 'string' ? conversation.last_preview.trim() : ''
  return Boolean(preview) || parseTime(conversation.last_message_at) !== null
}

/** 会话产物 → 方案文件：只取文档类文件；同名文件（多次生成的版本）只保留最新一份。 */
export function fredSolutionFiles(artifacts: LocalFileMetadata[]): SolutionFile[] {
  const latest = new Map<string, SolutionFile>()
  for (const artifact of artifacts) {
    if (artifact.kind !== 'artifact') continue
    const format = solutionFileFormat(artifact.filename)
    if (!format) continue
    const file: SolutionFile = {
      id: artifact.id,
      name: artifact.filename,
      path: null,
      format,
      kind: 'created',
      exists: true,
      changedAt: parseTime(artifact.created_at),
      task: null,
      model: null,
      mimeType: artifact.mime_type,
    }
    const previous = latest.get(artifact.filename)
    if (!previous || (file.changedAt ?? 0) >= (previous.changedAt ?? 0)) latest.set(artifact.filename, file)
  }
  return [...latest.values()].sort((a, b) => (b.changedAt ?? 0) - (a.changedAt ?? 0))
}

export interface FredConversationArtifacts {
  conversation: ConversationMetadata
  artifacts: LocalFileMetadata[]
}

/**
 * 生成过方案文件的 Fred 会话 → 解决方案。
 * 私聊归属入口员工；群聊归属协调员工，缺失时记为「群聊协作」。
 */
export function fredSolutionsFromArtifacts(
  entries: FredConversationArtifacts[],
  experts: ExpertProjection[],
): SolutionSummary[] {
  const expertsById = new Map(experts.map(expert => [expert.employee_id, expert]))
  const solutions: SolutionSummary[] = []
  for (const { conversation, artifacts } of entries) {
    const files = fredSolutionFiles(artifacts)
    if (files.length === 0) continue
    const isGroup = conversation.kind === 'group'
    const employeeId = isGroup ? conversation.coordinator_employee_id : conversation.entry_employee_id
    const expert = employeeId ? expertsById.get(employeeId) : undefined
    const employeeName = expert?.display_name ?? (isGroup ? '群聊协作' : '未知员工')
    const title = conversation.title?.trim() || (isGroup ? '未命名群聊' : `与 ${employeeName} 的会话`)
    const model = typeof expert?.model_policy?.model === 'string' ? expert.model_policy.model : null
    solutions.push({
      key: solutionKey('fred', conversation.id),
      source: 'fred',
      id: conversation.id,
      title,
      employeeName,
      employeeAvatarUrl: expert?.avatar_url ?? null,
      workspace: null,
      model,
      models: model ? [model] : [],
      createdAt: parseTime(conversation.created_at),
      updatedAt: files[0].changedAt ?? parseTime(conversation.last_message_at) ?? parseTime(conversation.updated_at),
      isGroup,
      files,
    })
  }
  return solutions
}

// -------------------- 列表筛选 --------------------

/** 任一文件由 DeepSeek 模型写出（或会话只记录了 DeepSeek 模型）的方案。 */
export function usesDeepSeek(solution: Pick<SolutionSummary, 'models'>): boolean {
  return solution.models.some(model => DEEPSEEK_MODEL.test(model))
}

export function matchesSource(solution: SolutionSummary, filter: SourceFilter): boolean {
  if (filter === 'all') return true
  if (filter === DEEPSEEK) return usesDeepSeek(solution)
  return solution.source === filter
}

export interface SolutionFilter {
  source: SourceFilter
  employee: string
  query: string
}

export function filterSolutions(solutions: SolutionSummary[], filter: SolutionFilter): SolutionSummary[] {
  const terms = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return solutions.filter(solution => {
    if (!matchesSource(solution, filter.source)) return false
    if (filter.employee && solution.employeeName !== filter.employee) return false
    if (terms.length === 0) return true
    const haystack = [
      solution.title,
      solution.employeeName,
      solution.workspace ?? '',
      SOURCE_LABELS[solution.source],
      ...solution.models,
      ...solution.files.flatMap(file => [file.name, file.task ?? '']),
    ].join('\n').toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
}

export function sortSolutions(solutions: SolutionSummary[]): SolutionSummary[] {
  return [...solutions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export interface EmployeeOption {
  name: string
  count: number
}

/** 员工筛选项：按方案数降序，同数按名称排序。 */
export function employeeOptions(solutions: SolutionSummary[], source: SourceFilter): EmployeeOption[] {
  const counts = new Map<string, number>()
  for (const solution of solutions) {
    if (!matchesSource(solution, source)) continue
    counts.set(solution.employeeName, (counts.get(solution.employeeName) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
}

// -------------------- 预览 --------------------

/** RFC 4180 风格的 CSV 解析（引号、转义引号、CRLF），只取前 maxRows 行，跳过空行。 */
export function parseCsv(text: string, maxRows = 200): { rows: string[][]; truncated: boolean } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const endRow = () => {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
    field = ''
  }
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char !== '"') field += char
      else if (source[index + 1] === '"') { field += '"'; index += 1 }
      else quoted = false
    } else if (char === '"' && field === '') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1
      endRow()
      if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), truncated: true }
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) endRow()
  return { rows: rows.slice(0, maxRows), truncated: rows.length > maxRows }
}

// 与应用 CSP 叠加生效：预览页只能用内联样式和 data: 图片/字体，不访问任何外部地址。
const HTML_PREVIEW_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:">'

/** HTML 预览文档：CSP 放在 doctype 之后，解析器会把它放进 head，不改变渲染模式。 */
export function sandboxedHtml(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0]
  return doctype ? `${doctype}${HTML_PREVIEW_CSP}${html.slice(doctype.length)}` : `${HTML_PREVIEW_CSP}${html}`
}

/** SVG 只以图片方式渲染：不执行脚本，也不加载外部资源。 */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
