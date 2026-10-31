import { createCustomGroup, replaceGroupOrchestration, supportsCustomGroups, supportsGroupEditing, updateGroupMembers } from './customGroups'
/**
 * Agent API 客户端汇出点。
 *
 * 使用方式:
 *   import { agentApi } from '@/api/agent'
 *   const { experts } = await agentApi.listExperts()
 *   const { conversations } = await agentApi.listConversations()
 *   await agentApi.submitPrompt(convId, { text }, crypto.randomUUID())
 *   const sub = agentApi.subscribeEvents({ conversationId, onEvent, onError, onClose })
 *
 * 工作台会话使用远端 Agent，与网页端共享历史和执行；本机身份校验单独使用 AgentApiClient。
 * getToken 通过 stores/agentAuth 提供,401 时触发登出。
 */
import { observations } from './observations'
import { approvals } from './approvals'
import { resolveBackendBaseUrl } from '../backend/config'
import { AgentApiClient, AgentApiError } from './client'
import {
  abortConversation,
  createConversation,
  deleteConversation,
  getConversation,
  getConversationContext,
  getConversationState,
  getPromptReceipt,
  introduceConversation,
  listConversations,
  listConversationSegments,
  listEntries,
  markConversationRead,
  resetConversationContext,
  setConversationState,
  setThinkingLevel,
  submitPrompt,
  updateConversation,
  updateConversationSegment,
} from './conversations'
import { getExpertReadiness, listExperts, listSolutions } from './experts'
import { deleteEmployeeMemory, getEmployeeMemorySummary, listEmployeeMemories } from './employeeMemories'
import type {
  OfficeFeed,
  OfficeScene,
  Page,
} from './types'
import { deleteFile, listFiles, uploadFile } from './files'
import { subscribeConversationEvents } from './events'
import {
  createAutomationTask,
  deleteAutomationTask,
  getAutomationTask,
  listAutomationTaskRuns,
  listAutomationTasks,
  listConnectors,
  setAutomationTaskAction,
  updateAutomationTask,
} from './automationTasks'
import {
  createLocalDirectoryChallenge,
  listLocalDirectories,
  registerLocalDirectory,
  revokeLocalDirectory,
  setLocalDirectoryBinding,
  supportsLocalDirectories,
  verifyLocalDirectoryCitation,
} from './localDirectories'
import { listKnowledgeSources } from './knowledgeSources'

// 单例客户端。base URL 与鉴权由构造函数直接从 store/env 读取,
// 避免在业务代码里散落 client 组装逻辑。
let clientSingleton: AgentApiClient | null = null
let localClientSingleton: AgentApiClient | null = null

// 延迟解析,避免与 store 形成 import 循环。stores/agentAuth 在挂载后填充 token。
function currentToken(): string | null {
  const globalRef = globalThis as { __agentToken?: string | null }
  return globalRef.__agentToken ?? null
}

function buildClient(): AgentApiClient {
  return new AgentApiClient({
    resolveBaseUrl: resolveBackendBaseUrl,
    getToken: currentToken,
    onUnauthorized: (reason) => {
      // stores/agentAuth 会订阅 401 事件并触发登出。
      window.dispatchEvent(new CustomEvent('agent-auth:unauthorized', { detail: reason }))
    },
  })
}

function getClient(): AgentApiClient {
  if (!clientSingleton) clientSingleton = buildClient()
  return clientSingleton
}

// 本地目录授权依赖桌面授权桥接（仅本机 Unix socket 可达），只能由随包的本机 Agent 处理。
// 桌面端上面的 client 也指向本机 Agent（它把会话等路由转发到远端）；这里单独保留一个
// 不触发登出的 client：本地目录面板的 401 只提示错误。
function getLocalClient(): AgentApiClient {
  if (!localClientSingleton) localClientSingleton = new AgentApiClient({ getToken: currentToken })
  return localClientSingleton
}

// 门面对象:业务代码只依赖 agentApi.*,不再单独 import 每个模块。
// 需要暴露 client 本体的场景(测试注入 mock fetch)走 AgentApiClient 构造函数。
export const agentApi = {
  getParticipants: (id: string) => observations(getClient()).getParticipants(id),
  searchMessages: (...args: Parameters<ReturnType<typeof observations>['searchMessages']>) => observations(getClient()).searchMessages(...args),
  getWorkRecords: (...args: Parameters<ReturnType<typeof observations>['getWorkRecords']>) => observations(getClient()).getWorkRecords(...args),
  getWorkChanges: (...args: Parameters<ReturnType<typeof observations>['getWorkChanges']>) => observations(getClient()).getWorkChanges(...args),
  getUsageStatistics: (...args: Parameters<ReturnType<typeof observations>['getUsageStatistics']>) => observations(getClient()).getUsageStatistics(...args),
  getUsageOutcomes: (...args: Parameters<ReturnType<typeof observations>['getUsageOutcomes']>) => observations(getClient()).getUsageOutcomes(...args),
  downloadFile: (convId: string, kind: 'attachment' | 'artifact', id: string) => getClient().request<Blob>({
    path: `/api/agent/conversations/${encodeURIComponent(convId)}/${kind === 'artifact' ? 'artifacts' : 'attachments'}/${encodeURIComponent(id)}`,
    binary: true, headers: { Accept: 'application/octet-stream' },
  }),
  listAllConversations: async () => {
    const conversations: import('./types').ConversationMetadata[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const result = await listConversations(getClient(), { limit: 100, cursor })
      conversations.push(...result.conversations)
      if (!result.page.has_more) break
      if (!result.page.next_cursor || cursors.has(result.page.next_cursor)) throw new Error('会话分页游标无效')
      cursor = result.page.next_cursor
      cursors.add(cursor)
    } while (cursor)
    return { conversations: [...new Map(conversations.map(c => [c.id, c])).values()] }
  },
  listEntriesPage: (id: string, query: { limit?: number; cursor?: string; entry_ref?: string }, signal?: AbortSignal) => getClient().request<{
    data: { conversation_id: string; entries: import('./types').ConversationEntry[] }; page: Page
  }>({ path: `/api/agent/conversations/${encodeURIComponent(id)}/entries`, query, raw: true, signal }),
  // -------- 会话 --------
  listConversations: (params?: Parameters<typeof listConversations>[1]) =>
    listConversations(getClient(), params),
  supportsCustomGroups: () => supportsCustomGroups(getClient()),
  createCustomGroup: (params: Parameters<typeof createCustomGroup>[1]) => createCustomGroup(getClient(), params),
  supportsGroupEditing: () => supportsGroupEditing(getClient()),
  updateGroupMembers: (id: string, body: Parameters<typeof updateGroupMembers>[2]) => updateGroupMembers(getClient(), id, body),
  replaceGroupOrchestration: (id: string, body: Parameters<typeof replaceGroupOrchestration>[2], dedicated: boolean) =>
    replaceGroupOrchestration(getClient(), id, body, dedicated),
  createConversation: (params: Parameters<typeof createConversation>[1]) =>
    createConversation(getClient(), params),
  getConversation: (id: string) => getConversation(getClient(), id),
  updateConversation: (id: string, patch: Parameters<typeof updateConversation>[2]) =>
    updateConversation(getClient(), id, patch),
  deleteConversation: (id: string) => deleteConversation(getClient(), id),
  markConversationRead: (id: string, lastReadEntryId: string | null) =>
    markConversationRead(getClient(), id, lastReadEntryId),
  getConversationState: (id: string) => getConversationState(getClient(), id),
  getPromptReceipt: (id: string, idempotencyKey: string) => getPromptReceipt(getClient(), id, idempotencyKey),
  setConversationState: (id: string, state: Parameters<typeof setConversationState>[2]) =>
    setConversationState(getClient(), id, state),
  getConversationContext: (id: string) => getConversationContext(getClient(), id),
  setThinkingLevel: (id: string, level: Parameters<typeof setThinkingLevel>[2]) =>
    setThinkingLevel(getClient(), id, level),
  resetConversationContext: (id: string, body?: Parameters<typeof resetConversationContext>[2]) =>
    resetConversationContext(getClient(), id, body),
  listConversationSegments: (id: string) => listConversationSegments(getClient(), id),
  updateConversationSegment: (id: string, segmentId: string, body: Parameters<typeof updateConversationSegment>[3]) =>
    updateConversationSegment(getClient(), id, segmentId, body),
  introduceConversation: (id: string) => introduceConversation(getClient(), id),
  submitPrompt: (id: string, body: Parameters<typeof submitPrompt>[2], idempotencyKey: string) =>
    submitPrompt(getClient(), id, body, idempotencyKey),
  listEntries: (id: string, signal?: AbortSignal) => listEntries(getClient(), id, signal),
  abortConversation: (id: string) => abortConversation(getClient(), id),

  // -------- 工具权限审批 --------
  listApprovals: (...args: Parameters<ReturnType<typeof approvals>['listApprovals']>) => approvals(getClient()).listApprovals(...args),
  decideApproval: (...args: Parameters<ReturnType<typeof approvals>['decideApproval']>) => approvals(getClient()).decideApproval(...args),

  // -------- Office / Org(只读投影) --------
  // 办公场景:employees + summary,员工工作状态大屏消费。
  getOfficeScene: () =>
    getClient().request<OfficeScene>({ method: 'GET', path: '/api/agent/office/scene' }),
  // 办公动态:目前仅 conversation_schedule 一类。
  getOfficeFeed: () =>
    getClient().request<OfficeFeed>({ method: 'GET', path: '/api/agent/office/feed' }),

  // -------- 员工/专家 --------
  listExperts: () => listExperts(getClient()),
  listSolutions: () => listSolutions(getClient()),
  getExpertReadiness: (employeeId: string) => getExpertReadiness(getClient(), employeeId),

  // -------- 员工记忆 --------
  listEmployeeMemories: (employeeId: string, query: Parameters<typeof listEmployeeMemories>[2], signal?: AbortSignal) =>
    listEmployeeMemories(getClient(), employeeId, query, signal),
  getEmployeeMemorySummary: (employeeId: string, scope?: Parameters<typeof getEmployeeMemorySummary>[2], signal?: AbortSignal) =>
    getEmployeeMemorySummary(getClient(), employeeId, scope, signal),
  deleteEmployeeMemory: (employeeId: string, memoryId: string) => deleteEmployeeMemory(getClient(), employeeId, memoryId),

  // -------- 自动化任务 --------
  listAutomationTasks: (query?: Parameters<typeof listAutomationTasks>[1]) => listAutomationTasks(getClient(), query),
  getAutomationTask: (taskId: string) => getAutomationTask(getClient(), taskId),
  createAutomationTask: (body: Parameters<typeof createAutomationTask>[1], key: string) => createAutomationTask(getClient(), body, key),
  updateAutomationTask: (taskId: string, body: Parameters<typeof updateAutomationTask>[2], etag: string) => updateAutomationTask(getClient(), taskId, body, etag),
  setAutomationTaskAction: (taskId: string, action: Parameters<typeof setAutomationTaskAction>[2], etag: string) => setAutomationTaskAction(getClient(), taskId, action, etag),
  deleteAutomationTask: (taskId: string, etag: string) => deleteAutomationTask(getClient(), taskId, etag),
  listAutomationTaskRuns: (taskId: string, query?: Parameters<typeof listAutomationTaskRuns>[2]) => listAutomationTaskRuns(getClient(), taskId, query),
  listConnectors: (employeeId?: string) => listConnectors(getClient(), employeeId),

  // -------- 受控本地目录知识库 --------
  // 桌面端是唯一授权方：票据由原生选择器签发，Agent 永远不会通过 HTTP 拿到路径。
  // 以下全部发往本机 Agent（getLocalClient），不走远端会话服务。
  supportsLocalDirectories: () => supportsLocalDirectories(getLocalClient()),
  listLocalDirectories: () => listLocalDirectories(getLocalClient()),
  createLocalDirectoryChallenge: () => createLocalDirectoryChallenge(getLocalClient()),
  registerLocalDirectory: (ticket: string) => registerLocalDirectory(getLocalClient(), ticket),
  setLocalDirectoryBinding: (directoryId: string, employeeId: string, enabled: boolean, expectedRevision: number) =>
    setLocalDirectoryBinding(getLocalClient(), directoryId, employeeId, enabled, expectedRevision),
  revokeLocalDirectory: (directoryId: string) => revokeLocalDirectory(getLocalClient(), directoryId),
  verifyLocalDirectoryCitation: (citationId: string, offset?: number) => verifyLocalDirectoryCitation(getLocalClient(), citationId, offset),
  // 企业 / 个人 / 本机知识来源索引；本机目录只在本机 Agent 上，401 只提示不登出。
  listKnowledgeSources: (source?: Parameters<typeof listKnowledgeSources>[1], signal?: AbortSignal) =>
    listKnowledgeSources(getLocalClient(), source, signal),

  // -------- 会话附件 --------
  listFiles: (
    convId: string,
    kind?: Parameters<typeof listFiles>[2],
  ) => listFiles(getClient(), convId, kind),
  uploadFile: (
    convId: string,
    kind: Parameters<typeof uploadFile>[2],
    file: Parameters<typeof uploadFile>[3],
  ) => uploadFile(getClient(), convId, kind, file),
  deleteFile: (
    convId: string,
    kind: Parameters<typeof deleteFile>[2],
    fileId: string,
  ) => deleteFile(getClient(), convId, kind, fileId),

  // -------- SSE --------
  // 事件订阅不走 AgentApiClient(需要 ReadableStream + 自定义重连);由 events.ts 内部
  // 独立选择 fetch 实现并读取 __agentToken。返回的 handle 支持 close() 与 lastEventId 快照。
  subscribeEvents: (options: Parameters<typeof subscribeConversationEvents>[0]) =>
    subscribeConversationEvents(options),
}

export { AgentApiClient, AgentApiError }
export type * from './types'
export type { TaskCategory, TaskPage, TaskRun, TaskSchedule, AutomationTask, Connector } from './automationTasks'
export type { ApprovalRecord, ApprovalDecision, ApprovalRiskLevel, ApprovalStatus } from './approvals'
export type {
  LocalDirectory,
  LocalDirectoryBinding,
  LocalDirectoryBindingUpdate,
  LocalDirectoryCitation,
  LocalDirectoryList,
  RegisteredLocalDirectory,
} from './localDirectories'
export { isRevisionConflict, LOCAL_DIRECTORIES_PATH } from './localDirectories'
