/** Native HTTP errors can contain URLs; expose only fixed, credential-free diagnostics. */
export function classifyTransportFailure(error: unknown, service = 'Agent'): { code: string; message: string } {
  const detail = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  if (/not allowed|forbidden|denied|scope/i.test(detail)) {
    return { code: 'client_http_permission_denied', message: '应用网络访问权限不足，请完全退出并更新或重新启动应用。' }
  }
  if (/plugin.*not found|command.*not found|invoke|ipc|__TAURI_INTERNALS__/i.test(detail)) {
    return { code: 'client_http_ipc_failed', message: '桌面端网络组件调用失败，请完全退出并重新启动应用。' }
  }
  if (/abort|cancel/i.test(detail)) {
    return { code: 'client_request_cancelled', message: '请求已取消，请重试。' }
  }
  return { code: 'client_transport_failed', message: `无法完成到${service}的网络请求，请检查服务连接后重试。` }
}
