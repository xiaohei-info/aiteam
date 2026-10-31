// The selected Agent API contract provides no enterprise configuration writes.
export function useEnterpriseWrite() {
  return { enabled: false, reason: '当前服务未开放此管理操作', status: 'not_implemented' as const }
}
