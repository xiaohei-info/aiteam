import { BackendApiClient } from './client'
import { login, resetPassword, resolveTenantByAccount } from '../agent/auth'
import { listExperts } from '../agent/experts'
import { fetchEmployeeAvatarContent, updateEmployeeAvatar } from '../agent/avatar'
import type { AudioTranscriptionRequest, AudioTranscriptionResult, MarketplaceTemplate, OrgTreeNode, Page } from '../agent/types'

const client = new BackendApiClient({
  getToken: () => (globalThis as { __agentToken?: string | null }).__agentToken ?? null,
  onUnauthorized: (reason) => window.dispatchEvent(new CustomEvent('agent-auth:unauthorized', { detail: reason })),
})

export const backendApi = {
  resolveTenantByAccount: (params: Parameters<typeof resolveTenantByAccount>[1]) => resolveTenantByAccount(client, params),
  login: (params: Parameters<typeof login>[1]) => login(client, params),
  resetPassword: (params: Parameters<typeof resetPassword>[1]) => resetPassword(client, params),
  transcribeAudio: (body: AudioTranscriptionRequest) => client.request<AudioTranscriptionResult>({ method: 'POST', path: '/api/agent/audio/transcriptions', body }),
  getOrgTree: () => client.request<OrgTreeNode>({ path: '/api/agent/org/tree' }),
  createOrgDepartment: (name: string, parentId?: string) => client.request<{ id: string; name: string; parent_id: string | null }>({ method: 'POST', path: '/api/agent/org/departments', body: parentId ? { name, parent_id: parentId } : { name } }),
  updateOrgDepartment: (departmentId: string, patch: { name?: string; parent_id?: string | null }) => client.request<{ id: string; name: string; parent_id: string | null }>({ method: 'PATCH', path: `/api/agent/org/departments/${encodeURIComponent(departmentId)}`, body: patch }),
  deleteOrgDepartment: (departmentId: string) => client.request<{ deleted: true; id: string }>({ method: 'DELETE', path: `/api/agent/org/departments/${encodeURIComponent(departmentId)}` }),
  promoteOrgDepartment: (departmentId: string, childId: string) => client.request<{ id: string; name: string; parent_id: string | null }>({ method: 'POST', path: `/api/agent/org/departments/${encodeURIComponent(departmentId)}/promote`, body: { child_id: childId } }),
  assignOrgDepartment: (employeeId: string, departmentId: string) => client.request<{ employee_id: string; department_id: string }>({ method: 'PATCH', path: `/api/agent/org/assignments/${encodeURIComponent(employeeId)}`, body: { department_id: departmentId } }),
  listExperts: () => listExperts(client),
  updateEmployeeAvatar: (employeeId: string, body: Parameters<typeof updateEmployeeAvatar>[2]) => updateEmployeeAvatar(client, employeeId, body),
  getEmployeeAvatarContent: (employeeId: string, version?: string | null) => fetchEmployeeAvatarContent(client, employeeId, version),
  listMarketplaceTemplates: async () => {
    const result = await client.request<{ data: MarketplaceTemplate[]; page: Page }>({ path: '/api/agent/marketplace/templates', raw: true })
    return { items: result.data, page: result.page }
  },
  getMarketplaceTemplate: (id: string) => client.request<MarketplaceTemplate>({ path: `/api/agent/marketplace/templates/${encodeURIComponent(id)}` }),
  // The documented legacy endpoint returns 410; preserve that failure for the UI.
  listKnowledgeBases: () => client.request<never>({ path: '/api/agent/knowledge-bases' }),
}
