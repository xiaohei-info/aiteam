import { invoke } from '@tauri-apps/api/core'
import { agentApi } from '../../api/agent'
import { isTauri } from '../../api/agent/runtime'
import type { ExpertProjection } from '../../api/agent/types'
import { classifyRequestError } from '../../lib/requestError'
import {
  fredProjects,
  fredWorkspaceKeys,
  fromLocalProject,
  hostErrorMessage,
  LOCAL_PROJECT_SOURCES,
  localSourceStates,
  type FredWorkspaceWire,
  type LocalProjectListWire,
  type ProjectFile,
  type ProjectFileContentWire,
  type ProjectPart,
  type ProjectSummary,
  type RunStatus,
  type RunUnit,
  type SourceState,
  type StartOutcome,
} from './projects'

export interface SourceLoadResult {
  projects: ProjectSummary[]
  states: SourceState[]
}

/** 与宿主 MAX_FRED_KEYS 一致。 */
const MAX_FRED_WORKSPACES = 1000

const hostError = (error: unknown, fallback?: string) => Object.assign(new Error(hostErrorMessage(error, fallback)), { cause: error })

const fredState = (status: SourceState['status'], count: number, message?: string): SourceState => ({
  source: 'fred', status, count, truncated: false, message,
})

/** Fred：接口给出每个会话的工作目录名，宿主按目录名列文件。 */
export async function loadFredProjects(): Promise<SourceLoadResult> {
  if (!isTauri()) return { projects: [], states: [fredState('desktop_only', 0)] }
  let experts: ExpertProjection[]
  let conversations
  try {
    const [expertsRes, workspacesRes] = await Promise.all([agentApi.listExperts(), agentApi.listWorkspaces()])
    experts = expertsRes.experts
    conversations = workspacesRes.conversations
  } catch (error) {
    return { projects: [], states: [fredState('error', 0, classifyRequestError(error, 'Fred 会话读取失败，请稍后重试。').message)] }
  }
  try {
    const keys = fredWorkspaceKeys(conversations, MAX_FRED_WORKSPACES)
    const workspaces = keys.length
      ? await invoke<FredWorkspaceWire[]>('list_fred_workspace_files', { workspaceKeys: keys })
      : []
    const projects = fredProjects(conversations, workspaces, experts)
    return { projects, states: [fredState('ready', projects.length)] }
  } catch (error) {
    return { projects: [], states: [fredState('error', 0, hostErrorMessage(error))] }
  }
}

/** 本机其他 Agent 只能由桌面宿主扫描；浏览器开发模式下标记为仅桌面可用。 */
export async function loadLocalProjects(): Promise<SourceLoadResult> {
  if (!isTauri()) {
    return {
      projects: [],
      states: LOCAL_PROJECT_SOURCES.map(source => ({ source, status: 'desktop_only', count: 0, truncated: false })),
    }
  }
  try {
    const list = await invoke<LocalProjectListWire>('list_agent_projects')
    return { projects: list.projects.map(fromLocalProject), states: localSourceStates(list) }
  } catch (error) {
    const message = hostErrorMessage(error)
    return {
      projects: [],
      states: LOCAL_PROJECT_SOURCES.map(source => ({ source, status: 'error', count: 0, truncated: false, message })),
    }
  }
}

const target = (part: Pick<ProjectPart, 'source' | 'id'>) => ({ source: part.source, projectId: part.id })

/** 文件的文本内容；图片、文档和二进制文件为 null。失败时抛出带中文提示的 Error。 */
export async function readProjectFile(part: ProjectPart, file: ProjectFile): Promise<string | null> {
  try {
    const result = await invoke<ProjectFileContentWire>('read_project_file', { ...target(part), fileId: file.id })
    return result.content
  } catch (error) {
    throw hostError(error, '文件读取失败，请重试')
  }
}

/** 用系统默认应用打开文件（不传 file 时打开项目目录），或在 Finder / 资源管理器中显示。 */
export async function openProjectFile(part: ProjectPart, file: ProjectFile | null, reveal: boolean): Promise<void> {
  try {
    await invoke('open_project_file', { ...target(part), fileId: file?.id ?? null, reveal })
  } catch (error) {
    throw hostError(error, reveal ? '无法在文件夹中显示，请重试' : '无法用系统应用打开，请重试')
  }
}

/** 目录里能单独运行的单元：目录本身是一个应用时只有它，否则每个子文件夹应用各一个。 */
export async function detectUnits(part: ProjectPart): Promise<RunUnit[]> {
  try {
    return await invoke<RunUnit[]>('detect_project_runner', target(part))
  } catch (error) {
    throw hostError(error)
  }
}

/** 运行并在系统浏览器打开；代码项目第一次（或命令、依赖变化后）先返回待确认的命令。 */
export async function startProject(part: ProjectPart, dir: string, options: { fileId?: string | null; consent?: string | null } = {}): Promise<StartOutcome> {
  try {
    return await invoke<StartOutcome>('start_project', { ...target(part), dir, fileId: options.fileId ?? null, consent: options.consent ?? null })
  } catch (error) {
    throw hostError(error, '运行失败，请重试')
  }
}

export async function stopProject(part: ProjectPart, dir: string): Promise<RunStatus> {
  try {
    return await invoke<RunStatus>('stop_project', { ...target(part), dir })
  } catch (error) {
    throw hostError(error, '停止失败，请重试')
  }
}

export async function projectRunStatus(part: ProjectPart, dir: string): Promise<RunStatus> {
  return invoke<RunStatus>('project_run_status', { ...target(part), dir })
}

const DETECT_CONCURRENCY = 4
const NOT_RUNNABLE: RunUnit[] = [{ dir: '', runner: { kind: 'none' } }]

/** 逐个识别运行单元并取各单元当前运行状态（应用内可能已在运行）；单个失败按不可运行处理。 */
export async function detectRunners(
  parts: ProjectPart[],
  onResult: (part: ProjectPart, units: RunUnit[], statuses: Record<string, RunStatus>) => void,
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < parts.length) {
      const part = parts[next]
      next += 1
      const units = await detectUnits(part).catch(() => NOT_RUNNABLE)
      const statuses = await Promise.all(units.map(unit => projectRunStatus(part, unit.dir).catch(() => null)))
      onResult(part, units, Object.fromEntries(units.flatMap((unit, index) => {
        const status = statuses[index]
        return status?.phase ? [[unit.dir, status] as const] : []
      })))
    }
  }
  await Promise.all(Array.from({ length: Math.min(DETECT_CONCURRENCY, parts.length) }, worker))
}
