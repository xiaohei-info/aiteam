export type AgentRuntimeFailureCode =
  | 'client_agent_package_missing'
  | 'client_agent_host_outdated'
  | 'client_agent_configuration'
  | 'client_agent_connection'
  | 'client_agent_readiness'
  | 'client_agent_runtime'

export class AgentRuntimeError extends Error {
  readonly code: AgentRuntimeFailureCode
  readonly stage: 'health' | 'readiness'

  constructor(code: AgentRuntimeFailureCode, message: string, stage: 'health' | 'readiness' = 'health') {
    super(message)
    this.name = 'AgentRuntimeError'
    this.code = code
    this.stage = stage
  }
}

/** Native IPC may reject with strings. Expose known recovery instructions only. */
export function normalizeAgentRuntimeError(reason: unknown): AgentRuntimeError {
  const message = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : ''
  if (/未安装新版本机 Agent 包/.test(message)) {
    return new AgentRuntimeError('client_agent_package_missing', '缺少新版本机 Agent 运行包及企业公共配置。请将完整包放入 src-tauri/resources/agent，再使用 pnpm tauri dev --config src-tauri/tauri.agent.conf.json 启动；仅刷新页面无法补齐安装包。')
  }
  if (/get_agent_base_url/i.test(message) && /not found|unknown command|does not exist/i.test(message)) {
    return new AgentRuntimeError('client_agent_host_outdated', '当前原生程序不支持本机 Agent 启动命令。请退出桌面程序并重新运行 pnpm tauri dev --config src-tauri/tauri.agent.conf.json；前端热更新不能更新原生命令。')
  }
  if (/JWKS|公钥|公共配置|版本过旧|API 契约|另一个客户端/.test(message)) {
    return new AgentRuntimeError('client_agent_configuration', /另一个客户端/.test(message)
      ? '另一个桌面客户端正在使用本机 Agent，请切换到已打开的窗口或退出重复实例。'
      : '本机 Agent 配置或版本未通过检查，请核对配套公共配置、公钥及新版运行包后重新启动。')
  }
  if (/就绪|运行环境/.test(message)) {
    return new AgentRuntimeError('client_agent_readiness', '本机 Agent 已启动，但运行环境尚未就绪，请稍后重试并检查本机配置。', 'readiness')
  }
  if (/尚未响应|健康检查|动态端口超时/.test(message)) {
    return new AgentRuntimeError('client_agent_connection', '尚未连接到本机 Agent，请稍后重试；若持续失败，请检查运行包和进程启动状态。')
  }
  return new AgentRuntimeError('client_agent_runtime', '本机 Agent 启动或发现失败，请检查运行包和本机进程状态后重试。')
}
