import type { LocalCapability } from './types.ts'

import type { ServiceApiClient } from './client'

type RequestClient = Pick<ServiceApiClient, 'request'>

/** 用户在对话中同意安装的个人能力（只在本机、只对本人生效）。 */
export async function listLocalCapabilities(client: RequestClient): Promise<LocalCapability[]> {
  return (await client.request<LocalCapability[] | null>({ method: 'GET', path: '/api/agent/capabilities' })) ?? []
}

export async function deleteLocalCapability(client: RequestClient, kind: 'mcp', ref: string): Promise<void> {
  await client.request({
    method: 'DELETE',
    path: `/api/agent/capabilities/${encodeURIComponent(kind)}/${encodeURIComponent(ref)}`,
  })
}
