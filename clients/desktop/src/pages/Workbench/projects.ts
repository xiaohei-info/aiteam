/**
 * 工作台：AI Agent 做出的项目（vibecoding 产物）。一个项目 = 一个目录，可看文件、可一键运行。
 *
 * - Fred：本机 Agent 会话的受管工作目录。私聊一个目录；群聊合成一个项目，每个员工的目录是一部分
 *   （含已移出成员）。目录索引来自 GET /api/agent/workspaces，文件由桌面宿主按目录名列出。
 * - Codex / Claude Code / Claude 桌面版 / WorkBuddy：桌面宿主只读识别 Agent 新建的目录
 *   （见 src-tauri/src/agent_projects.rs），用户自己的仓库不算。
 * - DeepSeek 不是来源，而是按模型筛选：任一来源上由 DeepSeek 模型做出的项目都算，与来源重复计数。
 *
 * 本文件只放纯函数，便于 node 测试。
 */
import type { ConversationWorkspaces, ExpertProjection } from '../../api/agent/types'

/** 桌面宿主扫描的本机 Agent，与 Rust 侧 AgentSource 的序列化值一致。 */
export type LocalProjectSource = 'codex' | 'claude' | 'claude_desktop' | 'workbuddy'

export type ProjectSource = 'fred' | LocalProjectSource

export const LOCAL_PROJECT_SOURCES: LocalProjectSource[] = ['codex', 'claude', 'claude_desktop', 'workbuddy']

export const PROJECT_SOURCES: ProjectSource[] = ['fred', ...LOCAL_PROJECT_SOURCES]

export const SOURCE_LABELS: Record<ProjectSource, string> = {
  fred: 'Fred',
  codex: 'Codex',
  claude: 'Claude Code',
  claude_desktop: 'Claude 桌面版',
  workbuddy: 'WorkBuddy',
}

/** 按模型筛选，不对应任何客户端。 */
export const DEEPSEEK = 'deepseek'

export type SourceFilter = ProjectSource | typeof DEEPSEEK | 'all'

export const FILTER_LABELS: Record<Exclude<SourceFilter, 'all'>, string> = { ...SOURCE_LABELS, deepseek: 'DeepSeek' }

const DEEPSEEK_MODEL = /deepseek/i

/** 与 Rust 侧 FileFormat 一致。image / document 没有文本内容，只能用系统应用打开。 */
export type FileFormat = 'markdown' | 'text' | 'html' | 'csv' | 'svg' | 'code' | 'image' | 'document' | 'other'

export interface ProjectFile {
  id: string
  /** 相对项目目录（群聊为员工目录），`/` 分隔。 */
  path: string
  name: string
  format: FileFormat
  size: number
  modifiedAt: number | null
}

/**
 * 能单独读文件、单独运行的目录。普通项目只有一部分；Fred 群聊每个员工一部分。
 * `source` + `id` 就是交给宿主的项目标识（Fred 为 workspace_key）。
 */
export interface ProjectPart {
  source: ProjectSource
  id: string
  /** 群聊里的员工名；普通项目为 null。 */
  label: string | null
  removed: boolean
  fileCount: number
  truncated: boolean
  files: ProjectFile[]
}

export interface ProjectSummary {
  key: string
  source: ProjectSource
  id: string
  name: string
  description: string | null
  employeeName: string
  employeeAvatarUrl: string | null
  /** 本机目录（`~/…`）；Fred 不显示路径。 */
  location: string | null
  models: string[]
  createdAt: number | null
  updatedAt: number | null
  isGroup: boolean
  /** Fred 会话，用于「回到会话」。 */
  conversationId: string | null
  /** 至少一部分，每部分至少一个文件。 */
  parts: ProjectPart[]
  fileCount: number
  truncated: boolean
}

export type SourceStatus = 'ready' | 'missing' | 'desktop_only' | 'error'

export interface SourceState {
  source: ProjectSource
  status: SourceStatus
  count: number
  truncated: boolean
  message?: string
}

export const projectKey = (source: ProjectSource, id: string) => `${source}:${id}`
export const partKey = (part: Pick<ProjectPart, 'source' | 'id'>) => `${part.source}:${part.id}`

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

// -------------------- 桌面宿主命令返回值 --------------------

export interface ProjectFileWire {
  id: string
  path: string
  format: FileFormat
  size: number
  modified_at: number | null
}

export interface LocalProjectWire {
  source: LocalProjectSource
  id: string
  name: string
  description: string | null
  employee_name: string
  model: string | null
  models: string[]
  location: string
  created_at: number | null
  updated_at: number | null
  file_count: number
  truncated: boolean
  files: ProjectFileWire[]
}

export interface LocalProjectListWire {
  sources: { source: LocalProjectSource; available: boolean; project_count: number; truncated: boolean; creation_time_unavailable: boolean }[]
  projects: LocalProjectWire[]
}

export interface FredWorkspaceWire {
  workspace_key: string
  name: string | null
  description: string | null
  updated_at: number | null
  file_count: number
  truncated: boolean
  files: ProjectFileWire[]
}

/** 宿主列出的 Fred 目录；上限由宿主决定，超出时 truncated 为 true。 */
export interface FredWorkspaceListWire {
  workspaces: FredWorkspaceWire[]
  truncated: boolean
}

export interface ProjectFileContentWire {
  name: string
  path: string
  format: FileFormat
  size: number
  content: string | null
}

const fromFileWire = (file: ProjectFileWire): ProjectFile => ({
  id: file.id,
  path: file.path,
  name: baseName(file.path),
  format: file.format,
  size: file.size,
  modifiedAt: file.modified_at,
})

export function fromLocalProject(wire: LocalProjectWire): ProjectSummary {
  const part: ProjectPart = {
    source: wire.source,
    id: wire.id,
    label: null,
    removed: false,
    fileCount: wire.file_count,
    truncated: wire.truncated,
    files: wire.files.map(fromFileWire),
  }
  return {
    key: projectKey(wire.source, wire.id),
    source: wire.source,
    id: wire.id,
    name: wire.name,
    description: wire.description,
    employeeName: wire.employee_name,
    employeeAvatarUrl: null,
    location: wire.location,
    models: wire.models.length ? wire.models : wire.model ? [wire.model] : [],
    createdAt: wire.created_at,
    updatedAt: wire.updated_at,
    isGroup: false,
    conversationId: null,
    parts: [part],
    fileCount: wire.file_count,
    truncated: wire.truncated,
  }
}

export function localSourceStates(list: LocalProjectListWire): SourceState[] {
  return list.sources.map(item => ({
    source: item.source,
    status: item.available ? 'ready' : 'missing',
    count: item.project_count,
    truncated: item.truncated,
    message: item.creation_time_unavailable ? '部分会话无法判断目录创建时间，已跳过' : undefined,
  }))
}

// -------------------- Fred --------------------

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

/** 交给宿主列文件的目录：只取接口判断为有文件的目录，去重，保持接口给出的新到旧顺序（宿主超出上限时截掉旧的）。 */
export function fredWorkspaceKeys(conversations: ConversationWorkspaces[]): string[] {
  const keys = new Set<string>()
  for (const conversation of conversations) {
    for (const workspace of conversation.workspaces) {
      if (workspace.has_files) keys.add(workspace.workspace_key)
    }
  }
  return [...keys]
}

const expertModel = (expert: ExpertProjection | undefined): string | null =>
  typeof expert?.model_policy?.model === 'string' ? expert.model_policy.model : null

/**
 * 会话 + 宿主列出的目录 → Fred 项目；没有文件的会话不出现。
 * 私聊归属入口员工；群聊归属协调员工，每个员工的目录是一部分，已移出的成员也保留。
 */
export function fredProjects(
  conversations: ConversationWorkspaces[],
  workspaces: FredWorkspaceWire[],
  experts: ExpertProjection[],
): ProjectSummary[] {
  const expertsById = new Map(experts.map(expert => [expert.employee_id, expert]))
  const listed = new Map(workspaces.map(workspace => [workspace.workspace_key, workspace]))
  const projects: ProjectSummary[] = []
  for (const conversation of conversations) {
    const isGroup = conversation.kind === 'group'
    const employeeName = (id: string | null) => (id ? expertsById.get(id)?.display_name : undefined)
    const parts: ProjectPart[] = []
    const folders: FredWorkspaceWire[] = []
    const models = new Set<string>()
    for (const workspace of conversation.workspaces) {
      const folder = listed.get(workspace.workspace_key)
      if (!folder || folder.files.length === 0) continue
      folders.push(folder)
      const model = expertModel(workspace.employee_id ? expertsById.get(workspace.employee_id) : undefined)
      if (model) models.add(model)
      parts.push({
        source: 'fred',
        id: folder.workspace_key,
        label: isGroup ? employeeName(workspace.employee_id) ?? '未知员工' : null,
        removed: workspace.removed,
        fileCount: folder.file_count,
        truncated: folder.truncated,
        files: folder.files.map(fromFileWire),
      })
    }
    if (parts.length === 0) continue
    const ownerId = isGroup ? conversation.coordinator_employee_id : conversation.entry_employee_id
    const owner = ownerId ? expertsById.get(ownerId) : undefined
    const ownerName = owner?.display_name ?? (isGroup ? '群聊协作' : '未知员工')
    const title = conversation.title?.trim() || null
    // 私聊：项目清单里的名称优先；群聊由多个目录组成，用会话标题。
    const name = (!isGroup ? folders[0].name : null) ?? title ?? (isGroup ? '未命名群聊' : `与 ${ownerName} 的会话`)
    const updated = folders.map(folder => folder.updated_at ?? 0)
    projects.push({
      key: projectKey('fred', conversation.conversation_id),
      source: 'fred',
      id: conversation.conversation_id,
      name,
      description: folders.find(folder => folder.description)?.description ?? null,
      employeeName: ownerName,
      employeeAvatarUrl: owner?.avatar_url ?? null,
      location: null,
      models: [...models],
      createdAt: null,
      updatedAt: Math.max(...updated) || parseTime(conversation.updated_at),
      isGroup,
      conversationId: conversation.conversation_id,
      parts,
      fileCount: parts.reduce((total, part) => total + part.fileCount, 0),
      truncated: parts.some(part => part.truncated),
    })
  }
  return projects
}

// -------------------- 错误提示 --------------------

const ERROR_MESSAGES: Record<string, string> = {
  home_unavailable: '无法确定当前用户目录',
  data_dir_unavailable: '无法确定应用数据目录',
  invalid_source: '不支持的 Agent 来源',
  invalid_project_id: '项目标识无效',
  invalid_workspace_key: '工作目录标识无效',
  invalid_file_id: '文件标识无效',
  project_not_found: '该项目目录已不存在或已被移动',
  file_not_found: '该文件已不在项目中',
  file_missing: '文件已删除或移动',
  file_too_large: '文件超过 2 MB，请用默认应用打开',
  file_unreadable: '没有权限读取该文件',
  file_required: '请先选择要打开的 HTML 文件',
  open_failed: '无法用系统应用打开',
  scan_failed: '读取本机 Agent 记录失败',
  not_runnable: '该项目没有可运行的入口',
  node_unavailable: '随包 Node 运行环境缺失，请重新安装 AIFred',
  python_unavailable: '未找到 python3，请先安装 Python 3',
  dependencies_unreadable: '无法读取依赖文件（package.json / requirements.txt），或文件超过 1 MB',
  consent_failed: '保存运行确认失败，请重试',
  server_failed: '本地服务启动失败，请重试',
  run_failed: '运行失败，请重试',
  invalid_download_source: '下载源地址无效：需以 http:// 或 https:// 开头，不能包含空格或账号密码',
  download_source_failed: '保存下载源失败，请重试',
}

export function hostErrorMessage(error: unknown, fallback = '读取本机 Agent 记录失败'): string {
  const code = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  return ERROR_MESSAGES[code] ?? fallback
}

// -------------------- 列表筛选 --------------------

export function usesDeepSeek(project: Pick<ProjectSummary, 'models'>): boolean {
  return project.models.some(model => DEEPSEEK_MODEL.test(model))
}

export function matchesSource(project: ProjectSummary, filter: SourceFilter): boolean {
  if (filter === 'all') return true
  if (filter === DEEPSEEK) return usesDeepSeek(project)
  return project.source === filter
}

export interface ProjectFilter {
  source: SourceFilter
  employee: string
  query: string
}

export function filterProjects(projects: ProjectSummary[], filter: ProjectFilter): ProjectSummary[] {
  const terms = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return projects.filter(project => {
    if (!matchesSource(project, filter.source)) return false
    if (filter.employee && project.employeeName !== filter.employee) return false
    if (terms.length === 0) return true
    const haystack = [
      project.name,
      project.description ?? '',
      project.employeeName,
      project.location ?? '',
      SOURCE_LABELS[project.source],
      ...project.models,
      ...project.parts.flatMap(part => [part.label ?? '', ...part.files.map(file => file.path)]),
    ].join('\n').toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
}

export function sortProjects(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.name.localeCompare(b.name, 'zh-CN'))
}

export interface EmployeeOption {
  name: string
  count: number
}

/** 员工筛选项：按项目数降序，同数按名称排序。 */
export function employeeOptions(projects: ProjectSummary[], source: SourceFilter): EmployeeOption[] {
  const counts = new Map<string, number>()
  for (const project of projects) {
    if (!matchesSource(project, source)) continue
    counts.set(project.employeeName, (counts.get(project.employeeName) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
}

// -------------------- 文件树 --------------------

export type TreeNode =
  | { kind: 'dir'; key: string; name: string; depth: number; children: TreeNode[]; removed?: boolean }
  | { kind: 'file'; key: string; name: string; depth: number; part: number; file: ProjectFile }

export const fileNodeKey = (part: Pick<ProjectPart, 'source' | 'id'>, file: Pick<ProjectFile, 'id'>) => `${partKey(part)}/${file.id}`

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN') : a.kind === 'dir' ? -1 : 1))
  for (const node of nodes) if (node.kind === 'dir') sortNodes(node.children)
  return nodes
}

function insertFiles(nodes: TreeNode[], part: ProjectPart, index: number, prefix: string, depth: number) {
  const dirs = new Map<string, Extract<TreeNode, { kind: 'dir' }>>()
  for (const node of nodes) if (node.kind === 'dir') dirs.set(node.key, node)
  for (const file of part.files) {
    const segments = file.path.split('/').filter(Boolean)
    let level = nodes
    let key = prefix
    segments.slice(0, -1).forEach((segment, offset) => {
      key = `${key}/${segment}`
      let dir = dirs.get(key)
      if (!dir) {
        dir = { kind: 'dir', key, name: segment, depth: depth + offset, children: [] }
        dirs.set(key, dir)
        level.push(dir)
      }
      level = dir.children
    })
    level.push({ kind: 'file', key: fileNodeKey(part, file), name: file.name, depth: depth + segments.length - 1, part: index, file })
  }
}

/** 项目文件树：目录在前、按名称排序；群聊第一层是员工名。 */
export function buildFileTree(project: Pick<ProjectSummary, 'isGroup' | 'parts'>): TreeNode[] {
  const roots: TreeNode[] = []
  project.parts.forEach((part, index) => {
    if (!project.isGroup) {
      insertFiles(roots, part, index, partKey(part), 0)
      return
    }
    const name = part.removed ? `${part.label ?? '未知员工'}（已移出）` : part.label ?? '未知员工'
    const dir: TreeNode = { kind: 'dir', key: partKey(part), name, depth: 0, children: [], removed: part.removed }
    insertFiles(dir.children, part, index, partKey(part), 1)
    roots.push(dir)
  })
  // 群聊保持接口给出的员工顺序（协调员工在前），只排序每个员工目录内部。
  if (project.isGroup) {
    for (const node of roots) if (node.kind === 'dir') sortNodes(node.children)
    return roots
  }
  return sortNodes(roots)
}

/** 默认展开前两层，其余收起；`toggled` 记录用户点过的目录。 */
export function isExpanded(node: Extract<TreeNode, { kind: 'dir' }>, toggled: ReadonlySet<string>): boolean {
  return (node.depth < 2) !== toggled.has(node.key)
}

/** 按当前展开状态展平成可渲染的行。 */
export function visibleTreeRows(nodes: TreeNode[], toggled: ReadonlySet<string>): TreeNode[] {
  const rows: TreeNode[] = []
  const walk = (level: TreeNode[]) => {
    for (const node of level) {
      rows.push(node)
      if (node.kind === 'dir' && isExpanded(node, toggled)) walk(node.children)
    }
  }
  walk(nodes)
  return rows
}

const README = /^readme(\.(md|markdown|txt))?$/i

/** 打开项目时默认选中的文件：根目录 README → 根目录 index.html → 最近修改的文件。 */
export function defaultFile(project: Pick<ProjectSummary, 'parts'>): { part: number; file: ProjectFile } | null {
  const candidates = project.parts.flatMap((part, index) => part.files.map(file => ({ part: index, file })))
  const atRoot = (pattern: RegExp) => candidates.find(({ file }) => !file.path.includes('/') && pattern.test(file.name))
  return atRoot(README)
    ?? atRoot(/^index\.html?$/i)
    ?? [...candidates].sort((a, b) => (b.file.modifiedAt ?? 0) - (a.file.modifiedAt ?? 0))[0]
    ?? null
}

// -------------------- 文件类型 --------------------

const FORMAT_LABELS: Record<FileFormat, string> = {
  markdown: 'Markdown', text: '文本', html: 'HTML', csv: 'CSV', svg: 'SVG', code: '代码', image: '图片', document: '文档', other: '文件',
}

const DOCUMENT_LABELS: Record<string, string> = {
  docx: 'Word', doc: 'Word', pptx: 'PPT', ppt: 'PPT', xlsx: 'Excel', xls: 'Excel', pdf: 'PDF',
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function fileTypeLabel(file: Pick<ProjectFile, 'name' | 'format'>): string {
  if (file.format === 'document') return DOCUMENT_LABELS[extensionOf(file.name)] ?? '文档'
  if (file.format === 'code') return extensionOf(file.name).toUpperCase() || '代码'
  return FORMAT_LABELS[file.format]
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// -------------------- 运行 --------------------

/** 与 Rust 侧 project_runner::detect::Runner 一致。 */
export type Runner =
  | { kind: 'node'; script: string }
  | { kind: 'python'; entry: string; dependencies: string; streamlit: boolean }
  | { kind: 'static'; dir: string }
  | { kind: 'html'; files: { id: string; path: string }[] }
  | { kind: 'none' }

export type RunnerKind = Runner['kind']

/** 与 Rust 侧 project_runner::detect::RunUnit 一致：dir 为空表示目录本身，否则是其中一个子文件夹。 */
export interface RunUnit {
  dir: string
  runner: Runner
  /** Python 项目，而这台电脑没有能运行的 Python。 */
  needs_python?: boolean
}

/** 运行状态、进行中操作和错误按「目录 + 单元」区分。 */
export const unitKey = (part: Pick<ProjectPart, 'source' | 'id'>, dir: string) => `${partKey(part)}#${dir}`

/** 在文件夹中显示子文件夹单元时定位到的文件（定位到它即打开该子文件夹）；目录本身为 null。 */
export function unitRevealFile(part: Pick<ProjectPart, 'files'>, dir: string): ProjectFile | null {
  if (!dir) return null
  const prefix = `${dir}/`
  const inside = part.files.filter(file => file.path.startsWith(prefix))
  return inside.find(file => file.path.indexOf('/', prefix.length) === -1) ?? inside[0] ?? null
}

export type RunPhase = 'preparing' | 'starting' | 'running' | 'exited' | 'failed' | 'stopped'

export interface RunStatus {
  running: boolean
  phase: RunPhase | null
  url: string | null
  exit_code: number | null
  url_timed_out: boolean
  /** 分配给代码项目的端口；没识别到地址时可以试着打开。 */
  port: number | null
  logs: string[]
}

export type StartOutcome =
  | { outcome: 'needs_consent'; commands: string[]; script: string | null; cwd: string; fingerprint: string }
  | ({ outcome: 'started' } & RunStatus)

export const RUNNER_LABELS: Record<RunnerKind, string> = {
  node: 'Node',
  python: 'Python',
  static: '网页',
  html: '网页',
  none: '不可运行',
}

const RUNNER_RANK: Record<RunnerKind, number> = { node: 4, python: 3, static: 2, html: 1, none: 0 }

/** 列表徽标：多个部分（群聊）或多个子文件夹应用取最「强」的运行方式；还没识别完返回 null。 */
export function projectRunnerKind(parts: (RunUnit[] | undefined)[]): RunnerKind | null {
  if (parts.some(units => units === undefined)) return null
  return parts
    .flatMap(units => units ?? [])
    .reduce<RunnerKind>((best, unit) => (RUNNER_RANK[unit.runner.kind] > RUNNER_RANK[best] ? unit.runner.kind : best), 'none')
}

/** 项目里可运行的单元数（列表卡片显示「3 个应用」）。 */
export function runnableUnitCount(parts: (RunUnit[] | undefined)[]): number {
  return parts.flatMap(units => units ?? []).filter(unit => unit.runner.kind !== 'none').length
}

/** 只由多个 HTML 组成的项目运行哪个页面：选中的是 HTML 就用它，否则第一个。 */
export function htmlPageToRun(runner: Runner, selectedFileId: string | null): string | null {
  if (runner.kind !== 'html') return null
  return runner.files.find(file => file.id === selectedFileId)?.id ?? runner.files[0]?.id ?? null
}

/** 运行方式的一句话说明，显示在运行按钮旁。 */
/** 确认弹窗里解释 npm 脚本实际执行什么；非 npm 项目或脚本取不到时为 null。 */
export function consentScriptLine(runner: Runner, script: string | null): string | null {
  return runner.kind === 'node' && script ? `npm run ${runner.script} 实际执行：${script}` : null
}

export function runnerDetail(runner: Runner): string {
  switch (runner.kind) {
    case 'node': return `npm run ${runner.script}`
    case 'python': return runner.streamlit ? `streamlit run ${runner.entry}` : `python ${runner.entry}`
    case 'static': return runner.dir ? `本地静态服务器 · ${runner.dir}/index.html` : '本地静态服务器 · index.html'
    case 'html': return `${runner.files.length} 个 HTML 页面 · 打开选中的页面`
    case 'none': return '没有可运行的入口，可在文件夹中查看'
  }
}

/** 代码项目由宿主推进状态（装依赖、启动、退出），需要轮询；静态服务器状态不会变。 */
export function needsPolling(runner: Runner | undefined, status: RunStatus | undefined): boolean {
  return Boolean(status?.running) && (runner?.kind === 'node' || runner?.kind === 'python')
}

export function runPhaseText(status: RunStatus | undefined): string | null {
  if (!status?.phase) return null
  switch (status.phase) {
    case 'preparing': return '正在安装依赖…'
    case 'starting': return status.url_timed_out ? '项目已启动，但没找到访问地址' : '正在启动…'
    case 'running': return '运行中'
    case 'exited': return status.exit_code === null ? '已退出' : `已退出（退出码 ${status.exit_code}）`
    case 'failed': return status.exit_code === null ? '运行失败，请查看日志' : `运行失败（退出码 ${status.exit_code}），请查看日志`
    case 'stopped': return '已停止'
  }
}

// -------------------- 依赖下载源 --------------------

/** 与 Rust 侧 project_runner::plan::DependencySource 一致；默认国内镜像。 */
export type DependencySource =
  | { mode: 'mirror' }
  | { mode: 'system' }
  | { mode: 'custom'; pypi: string | null; npm: string | null }

export const DEFAULT_DEPENDENCY_SOURCE: DependencySource = { mode: 'mirror' }

export const PYPI_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple'
export const NPM_MIRROR = 'https://registry.npmmirror.com'

export function dependencySourceLabel(source: DependencySource): string {
  switch (source.mode) {
    case 'mirror': return '国内镜像'
    case 'system': return '跟随系统配置'
    case 'custom': return '自定义'
  }
}

/** 自定义地址的前端校验（宿主会再校验一次）；合法返回 null。 */
export function sourceUrlError(value: string): string | null {
  const url = value.trim()
  if (!url) return null
  const match = /^https?:\/\/([^/]*)/i.exec(url)
  if (!match || !match[1]) return '需以 http:// 或 https:// 开头'
  if (match[1].includes('@')) return '不要在地址里写账号密码，请写在 pip / npm 自己的配置中'
  if (/\s/.test(url)) return '地址不能包含空格'
  if (url.length > 512) return '地址过长'
  return null
}

export function runStatusFromOutcome(outcome: StartOutcome): RunStatus | null {
  if (outcome.outcome !== 'started') return null
  const { outcome: _ignored, ...status } = outcome
  return status
}
