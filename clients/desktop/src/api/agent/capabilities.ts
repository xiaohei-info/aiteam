import type { CapabilityAutoInstall, InstallableSkill, LocalCapability, LocalCapabilityKind, McpBearerCredential, McpInstallRequest, McpInstallResult, McpLogin, McpProbe } from './types.ts'

import type { ServiceApiClient } from './client'

type RequestClient = Pick<ServiceApiClient, 'request'>

/** 用户在对话中同意安装的个人能力（只在本机、只对本人生效）。 */
export async function listLocalCapabilities(client: RequestClient): Promise<LocalCapability[]> {
  return (await client.request<LocalCapability[] | null>({ method: 'GET', path: '/api/agent/capabilities' })) ?? []
}

/** 经本机 Agent 读取企业目录里本人可自装的技能（企业端不可达时抛错）。 */
export async function listInstallableSkills(client: RequestClient): Promise<InstallableSkill[]> {
  return (await client.request<InstallableSkill[] | null>({ method: 'GET', path: '/api/agent/capabilities/installable-skills' })) ?? []
}

export async function deleteLocalCapability(client: RequestClient, kind: LocalCapabilityKind, ref: string): Promise<void> {
  await client.request({
    method: 'DELETE',
    path: `/api/agent/capabilities/${encodeURIComponent(kind)}/${encodeURIComponent(ref)}`,
  })
}

/** 本人授权「以后从平台目录安装时直接安装」的能力种类。 */
export async function listCapabilityAutoInstall(client: RequestClient): Promise<CapabilityAutoInstall[]> {
  return (await client.request<CapabilityAutoInstall[] | null>({ method: 'GET', path: '/api/agent/capabilities/auto-install' })) ?? []
}

/** 撤销后从平台目录安装该种能力恢复为每次审批；已装能力不受影响。 */
export async function deleteCapabilityAutoInstall(client: RequestClient, kind: LocalCapabilityKind): Promise<void> {
  await client.request({ method: 'DELETE', path: `/api/agent/capabilities/auto-install/${encodeURIComponent(kind)}` })
}

// -------------------- MCP 鉴权（设计 2026-11-18 MCP鉴权与配置导入） --------------------
// 令牌只在桌面端 → 本机 Agent 之间流转，不经过对话、不交给模型。

/** 不带凭据请求一次，判断该地址无需鉴权、需要浏览器登录还是需要访问令牌。 */
export async function probeMcpServer(client: RequestClient, url: string): Promise<McpProbe | null> {
  return client.request<McpProbe>({ method: 'POST', path: '/api/agent/capabilities/mcp/probe', body: { url } })
}

/** 添加个人技能：只能装企业开放给本人的技能；已装其他版本时须 replace=true（否则 409 skill_exists）。 */
export async function installSkill(client: RequestClient, skillId: string, replace = false): Promise<LocalCapability | null> {
  return client.request<LocalCapability>({ method: 'POST', path: '/api/agent/capabilities/skills', body: { skill_id: skillId, ...(replace ? { replace: true } : {}) } })
}

// -------------------- 自定义技能（设计 2026-11-18 自定义技能导入） --------------------
// 只在本机、只对本人会话生效，不上传、不经企业签名；preview=true 只校验返回预览。

export type CustomSkillSource = 'folder' | 'zip' | 'file' | 'text' | 'url' | 'clawhub'

export interface CustomSkillPreview {
  name: string
  description: string
  file_count: number
  total_bytes: number
  files: string[]
  origin_label: string
}

/** 一个包（文件夹 / zip / 网址）里可能有多个技能：检查后先列出，选一个再装。 */
export interface CustomSkillScanItem {
  /** 包内技能根（相对包根）；包根本身就是技能时为空串。 */
  root: string
  name: string
  description: string
  file_count: number
  total_bytes: number
  /** false 表示校验不过（reason 有中文原因），不会被安装。 */
  ok: boolean
  reason?: string
}

export interface CustomSkillImportRequest {
  source: CustomSkillSource
  path?: string
  skill_md?: string
  url?: string
  preview?: boolean
  /** 安装包内指定的技能根；一次装一个。缺省取第一个。folder / zip 可能扫出多个技能。 */
  roots?: string[]
  replace?: boolean
}

/** 批量安装时逐个技能的结果；失败项带 reason。 */
export interface CustomSkillInstallResultItem {
  root: string
  name: string
  ok: boolean
  reason?: string
}

/** ClawHub 同名技能的候选；界面列表让用户选。 */
export interface ClawHubCandidate {
  owner: string
  slug: string
  url: string
  downloads: number | null
}

/** ClawHub 安全扫描结论；两个扫描器可能互相冲突，界面并列显示。 */
export interface ClawHubSecurity {
  status: string
  has_warnings: boolean
  scanners: { name: string; status: string; recommendation?: string; severity?: string; verdict?: string; confidence?: string; issue_count?: number }[]
}

export interface ClawHubSkillInfo {
  /** 同名多作者时给界面挑；已确定作者时为 null。 */
  candidates: ClawHubCandidate[] | null
  security: ClawHubSecurity | null
  /** 被跳过的平台专用文件（如 OpenClaw 钩子）。 */
  skipped: string[]
}

export interface CustomSkillImportResult {
  preview: CustomSkillPreview | null
  scan: CustomSkillScanItem[] | null
  capability: LocalCapability | null
  results: CustomSkillInstallResultItem[] | null
  clawhub: ClawHubSkillInfo | null
}

/** 导入自定义技能；preview 为 true 时只校验并返回预览，不安装。 */
export async function importCustomSkill(client: RequestClient, body: CustomSkillImportRequest): Promise<CustomSkillImportResult | null> {
  return client.request<CustomSkillImportResult>({ method: 'POST', path: '/api/agent/capabilities/skills/custom', body })
}

/** 读取本机技能目录（仅本人导入的技能），供「在文件管理器中显示」用。 */
export async function getLocalSkillPath(client: RequestClient, ref: string): Promise<string | null> {
  const result = await client.request<{ path: string }>({ method: 'GET', path: `/api/agent/capabilities/skills/${encodeURIComponent(ref)}/local-path` })
  return result?.path ?? null
}

/** 添加个人 MCP；需要浏览器登录时返回 login，登录完成后 Agent 自动完成安装。 */
export async function installMcpServer(client: RequestClient, body: McpInstallRequest): Promise<McpInstallResult> {
  return (await client.request<McpInstallResult>({ method: 'POST', path: '/api/agent/capabilities/mcp', body })) ?? { capability: null, login: null }
}

/** 重新登录已安装的 MCP；令牌仍可用时返回 null。 */
export async function startMcpLogin(client: RequestClient, ref: string): Promise<McpLogin | null> {
  const data = await client.request<{ login: McpLogin | null }>({ method: 'POST', path: `/api/agent/capabilities/mcp/${encodeURIComponent(ref)}/auth` })
  return data?.login ?? null
}

/** 更新访问令牌：Agent 先用它读一次工具列表，被拒则不保存。 */
export async function updateMcpToken(client: RequestClient, ref: string, credential: McpBearerCredential): Promise<void> {
  await client.request({ method: 'PUT', path: `/api/agent/capabilities/mcp/${encodeURIComponent(ref)}/token`, body: credential })
}

/** 退出登录 / 清除令牌；MCP 保留安装。 */
export async function deleteMcpCredential(client: RequestClient, ref: string): Promise<void> {
  await client.request({ method: 'DELETE', path: `/api/agent/capabilities/mcp/${encodeURIComponent(ref)}/credential` })
}

export async function getMcpLogin(client: RequestClient, loginId: string): Promise<McpLogin | null> {
  return client.request<McpLogin>({ method: 'GET', path: `/api/agent/mcp-auth/logins/${encodeURIComponent(loginId)}` })
}

/** 让本机 Agent 用系统浏览器再次打开登录页；桌面端只传登录编号，不传网址。 */
export async function reopenMcpLogin(client: RequestClient, loginId: string): Promise<boolean> {
  const data = await client.request<{ opened: boolean }>({ method: 'POST', path: `/api/agent/mcp-auth/logins/${encodeURIComponent(loginId)}/open` })
  return data?.opened === true
}

export async function cancelMcpLogin(client: RequestClient, loginId: string): Promise<void> {
  await client.request({ method: 'POST', path: `/api/agent/mcp-auth/logins/${encodeURIComponent(loginId)}/cancel` })
}

/** 批准安装需要浏览器登录的 MCP 后，读取该审批对应的登录进度；还没开始登录时为 null。 */
export async function getApprovalMcpLogin(client: RequestClient, conversationId: string, approvalId: string): Promise<McpLogin | null> {
  return client.request<McpLogin | null>({
    method: 'GET',
    path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/approvals/${encodeURIComponent(approvalId)}/auth`,
  })
}
