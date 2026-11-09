/**
 * 工作台「交给员工继续做」：在 Fred 以外工具做出的项目目录中开启员工私聊。
 * Fred 自己的项目回到原会话继续，不走这里。前端只传宿主票据，目录路径由桌面宿主解析。
 */
import type { ConversationCreateRequest, ConversationMetadata } from '../api/agent/types'

export const MAX_CONVERSATION_TITLE = 200

export interface DevelopableProject {
  source: string
  name: string
  parts: ReadonlyArray<{ id: string }>
}

export function isMacUserAgent(userAgent: string): boolean {
  return /Macintosh|Mac OS X/.test(userAgent)
}

/** 不能交给员工的原因；可以时返回 null。Fred 项目不用这个入口。 */
export function projectHandoffBlock(env: { desktop: boolean; mac: boolean }): string | null {
  if (!env.desktop) return '仅桌面端可以把项目交给员工。'
  return env.mac ? null : '当前系统暂不支持把这类项目交给员工。'
}

/** 对话名：用户清空时回到项目名。 */
export function projectConversationTitle(input: string, projectName: string): string {
  return (input.trim() || projectName.trim()).slice(0, MAX_CONVERSATION_TITLE)
}

export interface ProjectConversationDeps {
  createChallenge: () => Promise<string>
  authorize: (challenge: string, source: string, projectId: string) => Promise<{ ticket: string }>
  create: (params: ConversationCreateRequest) => Promise<ConversationMetadata>
}

export async function createProjectConversation(
  deps: ProjectConversationDeps,
  input: { project: DevelopableProject; employeeId: string; title: string },
): Promise<ConversationMetadata> {
  const { project, employeeId } = input
  const name = project.name.trim().slice(0, MAX_CONVERSATION_TITLE) || '未命名项目'
  const base = { kind: 'chat', entry_employee_id: employeeId, title: projectConversationTitle(input.title, name) }
  const challenge = await deps.createChallenge()
  const { ticket } = await deps.authorize(challenge, project.source, project.parts[0]?.id ?? '')
  return deps.create({ ...base, project: { name, ticket } })
}

const errorCode = (error: unknown): string => {
  if (typeof error === 'string') return error
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  if (typeof code === 'string') return code
  return typeof message === 'string' ? message : ''
}

/** 新建项目对话失败时给用户看的文字；不显示服务端英文或内部信息。 */
export function describeProjectConversationError(error: unknown): string {
  switch (errorCode(error)) {
    case 'project_not_found':
    case 'project_workspace_unavailable':
      return '项目目录已不存在或已被移动，请刷新工作台后重试。'
    case 'project_ticket_invalid':
    case 'citation_expired':
      return '本次授权已过期，请重试。'
    case 'project_folder_not_allowed':
    case 'source_overlaps_runtime':
      return '这个目录不能交给员工，例如用户主目录或 Fred 的数据目录。'
    case 'employee_not_authorized':
      return '所选员工的授权已变化，请刷新后重试。'
    case 'invalid_project':
      return '项目信息已变化，请刷新工作台后重试。'
    case 'authorization_unavailable':
      return '本机授权服务暂不可用，请稍后重试。'
    default:
      return '新建对话失败，请重试。'
  }
}

/** 发送失败的专门提示；其他失败返回 null，由对话页显示通用文字。 */
export function projectSendFailure(error: unknown): string | null {
  return errorCode(error) === 'project_workspace_unavailable'
    ? '项目目录已不存在或已被移动，无法继续发送。可在输入框下方的「权限」里更换目录，历史消息仍可查看。'
    : null
}

/** 更换项目目录失败时给用户看的文字；用户关掉选择框时返回空串，不提示。 */
export function describeProjectFolderError(error: unknown): string {
  switch (errorCode(error)) {
    case 'cancelled':
      return ''
    case 'conversation_busy':
      return '员工正在回复，等这一轮结束后再更换目录。'
    case 'project_not_found':
    case 'project_workspace_unavailable':
      return '选中的文件夹不存在或无法打开，请重新选择。'
    case 'project_folder_not_allowed':
    case 'source_overlaps_runtime':
      return '这个文件夹不能作为项目目录，例如磁盘根目录、用户主目录或 Fred 的数据目录。'
    case 'project_ticket_invalid':
    case 'citation_expired':
      return '本次授权已过期，请重试。'
    case 'authorization_unavailable':
      return '本机授权服务暂不可用，请稍后重试。'
    default:
      return '更换目录失败，请重试。'
  }
}

/**
 * 每位员工最新的普通私聊。项目对话有独立的工作目录和记忆，
 * 「和某员工对话」不能落到这里。
 */
export function latestEmployeeConversations<T extends Pick<ConversationMetadata, 'kind' | 'entry_employee_id' | 'updated_at' | 'project'>>(
  conversations: readonly T[],
): Map<string, T> {
  const latest = new Map<string, T>()
  for (const conversation of conversations) {
    const employeeId = conversation.entry_employee_id
    if (conversation.kind === 'group' || conversation.project || !employeeId) continue
    const current = latest.get(employeeId)
    if (!current || Date.parse(conversation.updated_at) > Date.parse(current.updated_at)) latest.set(employeeId, conversation)
  }
  return latest
}
