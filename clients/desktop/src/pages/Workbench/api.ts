import { invoke } from '@tauri-apps/api/core'
import { agentApi } from '../../api/agent'
import { isTauri } from '../../api/agent/runtime'
import type { ConversationMetadata, ExpertProjection } from '../../api/agent/types'
import type { CachedFile } from '../../lib/fileCache'
import { classifyRequestError } from '../../lib/requestError'
import {
  fredSolutionsFromArtifacts,
  fromLocalFileContent,
  fromLocalSummary,
  hasConversationActivity,
  LOCAL_SOLUTION_SOURCES,
  localErrorMessage,
  localSourceStates,
  type FredConversationArtifacts,
  type LocalSolutionFileContentWire,
  type LocalSolutionListWire,
  type SolutionFile,
  type SolutionFileContent,
  type SolutionSummary,
  type SourceState,
} from './solutions'

export interface SourceLoadResult {
  solutions: SolutionSummary[]
  states: SourceState[]
}

const FRED_FILE_LIST_CONCURRENCY = 6

async function mapLimited<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const fredError = (message: string): SourceLoadResult => ({
  solutions: [],
  states: [{ source: 'fred', status: 'error', count: 0, truncated: false, message }],
})

/** 逐个会话读取产物列表；单个会话失败不影响其他会话。 */
export async function loadFredSolutions(): Promise<SourceLoadResult> {
  let experts: ExpertProjection[]
  let conversations: ConversationMetadata[]
  try {
    const [expertsRes, convsRes] = await Promise.all([agentApi.listExperts(), agentApi.listAllConversations()])
    experts = expertsRes.experts.filter(expert => !expert.revoked)
    conversations = convsRes.conversations.filter(hasConversationActivity)
  } catch (error) {
    return fredError(classifyRequestError(error, 'Fred 会话读取失败，请稍后重试。').message)
  }
  const results = await mapLimited(conversations, FRED_FILE_LIST_CONCURRENCY, async (conversation): Promise<FredConversationArtifacts | null> => {
    try {
      const { files } = await agentApi.listFiles(conversation.id, 'artifact')
      return { conversation, artifacts: files }
    } catch {
      return null
    }
  })
  const loaded = results.filter((result): result is FredConversationArtifacts => result !== null)
  const failed = results.length - loaded.length
  if (failed > 0 && loaded.length === 0) return fredError('会话文件读取失败，请稍后重试。')
  const solutions = fredSolutionsFromArtifacts(loaded, experts)
  return {
    solutions,
    states: [{
      source: 'fred',
      status: 'ready',
      count: solutions.length,
      truncated: false,
      message: failed > 0 ? `${failed} 个会话的文件读取失败` : undefined,
    }],
  }
}

/** 本机 Agent 记录只能由桌面宿主读取；浏览器开发模式下标记为仅桌面可用。 */
export async function loadLocalSolutions(): Promise<SourceLoadResult> {
  if (!isTauri()) {
    return {
      solutions: [],
      states: LOCAL_SOLUTION_SOURCES.map(source => ({ source, status: 'desktop_only', count: 0, truncated: false })),
    }
  }
  try {
    const list = await invoke<LocalSolutionListWire>('list_agent_solutions')
    return { solutions: list.solutions.map(fromLocalSummary), states: localSourceStates(list) }
  } catch (error) {
    const message = localErrorMessage(error)
    return {
      solutions: [],
      states: LOCAL_SOLUTION_SOURCES.map(source => ({ source, status: 'error', count: 0, truncated: false, message })),
    }
  }
}

const localTarget = (solution: SolutionSummary, file: SolutionFile) => ({ source: solution.source, id: solution.id, fileId: file.id })

/** 读取方案文件的最终内容。失败时抛出带中文提示的 Error，页面可直接展示 message。 */
export async function readSolutionFile(solution: SolutionSummary, file: SolutionFile): Promise<SolutionFileContent> {
  if (solution.source === 'fred') {
    if (file.format === 'document') return { text: null, fromRecord: false }
    try {
      const blob = await agentApi.downloadFile(solution.id, 'artifact', file.id)
      return { text: await blob.text(), fromRecord: false }
    } catch (error) {
      throw Object.assign(new Error(classifyRequestError(error, '文件读取失败，请稍后重试。').message), { cause: error })
    }
  }
  try {
    return fromLocalFileContent(await invoke<LocalSolutionFileContentWire>('read_agent_solution_file', localTarget(solution, file)))
  } catch (error) {
    throw Object.assign(new Error(localErrorMessage(error)), { cause: error })
  }
}

// Fred 产物 id 对应不可变内容（新版本会生成新 id），缓存路径可以长期复用。
const cachedFredFiles = new Map<string, string>()

async function cacheFredFile(solution: SolutionSummary, file: SolutionFile): Promise<string> {
  const key = `${solution.id}:${file.id}`
  const existing = cachedFredFiles.get(key)
  if (existing) return existing
  const blob = await agentApi.downloadFile(solution.id, 'artifact', file.id)
  const cached = await invoke<CachedFile>('cache_conversation_file', {
    userId: 'conversation-files',
    chatId: solution.id,
    filename: file.name,
    mimeType: file.mimeType ?? blob.type,
    data: Array.from(new Uint8Array(await blob.arrayBuffer())),
  })
  cachedFredFiles.set(key, cached.rel_path)
  return cached.rel_path
}

/** 浏览器开发模式下没有本机文件，只能在新标签页打开下载内容。 */
async function openFredFileInBrowser(solution: SolutionSummary, file: SolutionFile): Promise<void> {
  const blob = await agentApi.downloadFile(solution.id, 'artifact', file.id)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function canRevealSolutionFile(solution: SolutionSummary, file: SolutionFile): boolean {
  return isTauri() && file.exists && (solution.source === 'fred' || file.path !== null)
}

/** 用系统默认应用打开，或在 Finder / 资源管理器中显示。 */
export async function openSolutionFile(solution: SolutionSummary, file: SolutionFile, reveal: boolean): Promise<void> {
  const failure = reveal ? '无法在 Finder 中显示文件，请重试' : '文件打开失败，请重试'
  if (solution.source === 'fred') {
    try {
      if (!isTauri()) {
        await openFredFileInBrowser(solution, file)
        return
      }
      const relPath = await cacheFredFile(solution, file)
      await invoke(reveal ? 'show_in_folder' : 'open_cached_file', { relPath })
    } catch (error) {
      throw Object.assign(new Error(failure), { cause: error })
    }
    return
  }
  try {
    await invoke('open_agent_solution_file', { ...localTarget(solution, file), reveal })
  } catch (error) {
    throw Object.assign(new Error(localErrorMessage(error)), { cause: error })
  }
}
