import type { CapabilityAutoInstall, InstallableSkill, LocalCapability, LocalCapabilityKind } from './types.ts'

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
