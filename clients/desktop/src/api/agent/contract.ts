// Contract: 8783 baseline (2026-09-10) plus custom-group Agent extension (2026-09-11),
// synced with feat/local-directory-knowledge (2026-10-13): local-directory resources,
// bindings and citation verification; automation-task actions are enumerated
// (enable/pause) instead of a wildcard action segment.
// The new routes are enabled only after runtime OpenAPI capability detection.
// Snapshot reads and sync are deliberately not exposed by this desktop client.
export const documentedRoutes: readonly (readonly [string, string])[] = [
  ['GET', '/healthz'],
  ['GET', '/metrics'],
  ['GET', '/openapi.json'],
  // Custom-group API introduced by the companion Agent PR; capability checked before use.
  ['POST', '/api/agent/conversations/custom-group'],
  ['GET', '/redoc'],
  ['GET', '/redoc/redoc.standalone.js'],
  ['GET', '/readyz'],
  ['POST', '/api/auth/resolve-tenant-by-account'],
  ['POST', '/api/agent/login'],
  ['POST', '/api/agent/reset-password'],
  ['POST', '/api/agent/audio/transcriptions'],
  ['GET', '/api/agent/ping'],
  ['GET', '/api/agent/whoami'],
  ['GET', '/api/agent/conversations'],
  ['POST', '/api/agent/conversations'],
  ['GET', '/api/agent/conversations/{conversation_id}'],
  ['PATCH', '/api/agent/conversations/{conversation_id}'],
  ['PUT', '/api/agent/conversations/{conversation_id}'],
  ['DELETE', '/api/agent/conversations/{conversation_id}'],
  ['GET', '/api/agent/conversations/{conversation_id}/state'],
  ['PUT', '/api/agent/conversations/{conversation_id}/state'],
  ['GET', '/api/agent/conversations/{conversation_id}/context'],
  ['PATCH', '/api/agent/conversations/{conversation_id}/context'],
  // 「开启新上下文」；缺这一项时客户端在发请求前就拒绝，按钮点击后无任何请求到达 Agent。
  ['POST', '/api/agent/conversations/{conversation_id}/context/reset'],
  // 上下文段落的结果评估（解决了吗）；旧版随包 Agent 没有这两项时返回 404，前端按未评估处理。
  ['GET', '/api/agent/conversations/{conversation_id}/segments'],
  ['PATCH', '/api/agent/conversations/{conversation_id}/segments/{segment_id}'],
  // 发送后用幂等收据确认本轮是否结束；Agent 已注册该路由，但 OpenAPI 尚未登记。
  ['GET', '/api/agent/conversations/{conversation_id}/receipts/{idempotency_key}'],
  ['PUT', '/api/agent/conversations/{conversation_id}/thinking-level'],
  ['POST', '/api/agent/conversations/{conversation_id}/prompt'],
  // 人才市场发起的空单聊：员工先自我介绍（随包 Agent 需包含 feat/agent-skill-names-self-intro）。
  ['POST', '/api/agent/conversations/{conversation_id}/introduction'],
  ['GET', '/api/agent/conversations/{conversation_id}/events'],
  ['GET', '/api/agent/conversations/{conversation_id}/entries'],
  ['GET', '/api/agent/conversations/{conversation_id}/participants'],
  // Group member/orchestration editing (aiteam#90) ships in the bundled Agent package since source 6f8ec811; still
  // capability checked before use because browser development may target an older service.
  ['PATCH', '/api/agent/conversations/{conversation_id}/participants'],
  ['PUT', '/api/agent/conversations/{conversation_id}/orchestration'],
  ['GET', '/api/agent/messages/search'],
  ['POST', '/api/agent/conversations/{conversation_id}/abort'],
  ['GET', '/api/agent/conversations/{conversation_id}/approvals'],
  ['POST', '/api/agent/conversations/{conversation_id}/approvals/{approval_id}/decision'],
  ['GET', '/api/agent/conversations/{conversation_id}/attachments'],
  ['POST', '/api/agent/conversations/{conversation_id}/attachments'],
  ['GET', '/api/agent/conversations/{conversation_id}/artifacts'],
  ['POST', '/api/agent/conversations/{conversation_id}/artifacts'],
  ['GET', '/api/agent/conversations/{conversation_id}/attachments/{attachment_id}'],
  ['DELETE', '/api/agent/conversations/{conversation_id}/attachments/{attachment_id}'],
  ['GET', '/api/agent/conversations/{conversation_id}/artifacts/{artifact_id}'],
  ['DELETE', '/api/agent/conversations/{conversation_id}/artifacts/{artifact_id}'],
  ['GET', '/api/agent/grants/experts'],
  ['POST', '/api/agent/grants/sync'],
  ['GET', '/api/agent/grants/solutions'],
  ['GET', '/api/agent/grants/readiness'],
  ['GET', '/api/agent/grants/experts/{employee_id}/readiness'],
  ['POST', '/api/agent/employees/{employee_id}/avatar'],
  ['GET', '/api/agent/employees/{employee_id}/avatar/content'],
  // 员工记忆（转发 Manager，普通成员只看自己贡献的）；旧版随包 Agent 返回 404，员工详情隐藏入口。
  ['GET', '/api/agent/employees/{employee_id}/memories'],
  ['GET', '/api/agent/employees/{employee_id}/memories/summary'],
  ['DELETE', '/api/agent/employees/{employee_id}/memories/{memory_id}'],
  // 企业 / 个人 / 本机知识来源只读索引；旧版随包 Agent 返回 404，知识库页沿用原有显示。
  ['GET', '/api/agent/knowledge-sources'],
  ['GET', '/api/agent/work-records'],
  ['GET', '/api/agent/work-records/changes'],
  ['GET', '/api/agent/usage/statistics'],
  // 段落解决率；旧版随包 Agent 没有该项时返回 404，员工详情隐藏解决率。
  ['GET', '/api/agent/usage/outcomes'],
  ['GET', '/api/agent/usage/outbox'],
  ['POST', '/api/agent/usage/flush'],
  ['GET', '/api/agent/marketplace/templates'],
  ['GET', '/api/agent/marketplace/templates/{template_id}'],
  ['GET', '/api/agent/knowledge-bases'],
  ['GET', '/api/agent/knowledge-bases/{knowledge_base_id}/{kind}'],
  ['GET', '/api/agent/knowledge-bases/{knowledge_base_id}/{kind}/{resource_id}'],
  ['GET', '/api/agent/org/tree'],
  // Department management is forwarded to Manager, which enforces owner/enterprise_admin.
  ['POST', '/api/agent/org/departments'],
  ['PATCH', '/api/agent/org/departments/{department_id}'],
  ['POST', '/api/agent/org/departments/{department_id}/promote'],
  ['DELETE', '/api/agent/org/departments/{department_id}'],
  ['PATCH', '/api/agent/org/assignments/{employee_id}'],
  ['GET', '/api/agent/office/scene'],
  ['GET', '/api/agent/office/feed'],
  ['GET', '/api/agent/automation-tasks'],
  ['POST', '/api/agent/automation-tasks'],
  ['GET', '/api/agent/automation-tasks/{task_id}'],
  ['PATCH', '/api/agent/automation-tasks/{task_id}'],
  ['DELETE', '/api/agent/automation-tasks/{task_id}'],
  ['POST', '/api/agent/automation-tasks/{task_id}/actions/enable'],
  ['POST', '/api/agent/automation-tasks/{task_id}/actions/pause'],
  ['GET', '/api/agent/automation-tasks/{task_id}/runs'],
  ['GET', '/api/agent/connectors'],
  // Controlled local-directory knowledge (desktop is the only permission authority).
  ['GET', '/api/agent/local-directories'],
  ['POST', '/api/agent/local-directories'],
  ['POST', '/api/agent/local-directories/challenges'],
  ['PUT', '/api/agent/local-directories/{directory_id}/bindings/{employee_id}'],
  ['DELETE', '/api/agent/local-directories/{directory_id}'],
  ['POST', '/api/agent/local-directory-citations/{citation_id}/verify'],
]

export function isDocumentedRequest(method: string, path: string): boolean {
  if (!path.startsWith('/') || /[?#\\]/.test(path)) return false
  const segments = path.split('/')
  if (segments.some(segment => {
    try { return ['.', '..'].includes(decodeURIComponent(segment)) } catch { return true }
  })) return false
  return documentedRoutes.some(([verb, pattern]) => {
    const expected = pattern.split('/')
    return verb === method && expected.length === segments.length
      && expected.every((part, index) => part.startsWith('{') ? Boolean(segments[index]) : part === segments[index])
  })
}
