import { AgentRuntimeError } from './agentRuntimeError.ts'
import { classifyRequestError, type RequestErrorInfo } from './requestError.ts'
import type { SafeDiagnosticCode } from './appDiagnostics.ts'

export type BackendStartupStage = 'health' | 'readiness'
export type BackendStartupFailureCategory = 'configuration' | 'network' | 'service'

export interface BackendStartupFailure {
  category: BackendStartupFailureCategory
  diagnosticCode: SafeDiagnosticCode
  error: RequestErrorInfo
  stage: BackendStartupStage
  stageLabel: string
}

interface ErrorLike {
  code?: unknown
  name?: unknown
  status?: unknown
  problem?: {
    status?: unknown
  }
}

const CONFIGURATION_ERROR_CODES = new Set([
  'client_bad_content_type',
  'client_insecure_api_url',
  'client_path_denied',
  'client_agent_package_missing',
  'client_agent_host_outdated',
  'client_agent_configuration',
  'client_configuration_missing',
  'local_agent_start_failed',
])

export const BACKEND_STAGE_LABELS: Record<BackendStartupStage, string> = {
  health: '启动本机 Agent',
  readiness: '检查本机运行环境',
}

function asErrorLike(error: unknown): ErrorLike {
  return error && typeof error === 'object' ? error as ErrorLike : {}
}

function readStatus(value: ErrorLike): number | undefined {
  if (typeof value.status === 'number') return value.status
  return typeof value.problem?.status === 'number' ? value.problem.status : undefined
}

export function isBackendStartupConfigurationError(error: unknown): boolean {
  const value = asErrorLike(error)
  const code = typeof value.code === 'string' ? value.code : undefined
  if (code && CONFIGURATION_ERROR_CODES.has(code)) return true
  const status = readStatus(value)
  return status !== undefined && [400, 401, 403, 404, 405, 422].includes(status)
}

function isAbortError(error: unknown): boolean {
  const value = asErrorLike(error)
  return value.name === 'AbortError'
}

export function classifyBackendStartupFailure(
  error: unknown,
  stage: BackendStartupStage,
): BackendStartupFailure {
  if (error instanceof AgentRuntimeError) stage = error.stage
  const stageLabel = BACKEND_STAGE_LABELS[stage]

  if (asErrorLike(error).code === 'local_agent_start_failed') {
    return {
      category: 'configuration',
      diagnosticCode: 'BACKEND_CONFIGURATION_ERROR',
      error: {
        kind: 'unknown',
        title: '本地 Agent 启动失败',
        message: '请检查 AIFred 用户目录中的 agent.log 和 agent.env 配置，修正后重启应用。',
      },
      stage,
      stageLabel: '启动本地 Agent',
    }
  }

  if (isBackendStartupConfigurationError(error)) {
    return {
      category: 'configuration',
      diagnosticCode: error instanceof AgentRuntimeError && error.code === 'client_agent_package_missing'
        ? 'BACKEND_AGENT_NOT_INSTALLED'
        : error instanceof AgentRuntimeError && error.code === 'client_agent_host_outdated'
          ? 'BACKEND_HOST_RESTART_REQUIRED'
          : 'BACKEND_CONFIGURATION_ERROR',
      error: {
        kind: 'unknown',
        title: error instanceof AgentRuntimeError && error.code === 'client_agent_package_missing'
          ? '本机 Agent 尚未安装'
          : error instanceof AgentRuntimeError && error.code === 'client_agent_host_outdated'
            ? '请重新启动桌面程序'
            : '服务配置错误',
        message: error instanceof AgentRuntimeError ? error.message : `启动检测在“${stageLabel}”阶段被配置策略拒绝，请检查 API 地址、服务版本或运行配置后重试。`,
        status: readStatus(asErrorLike(error)),
      },
      stage,
      stageLabel,
    }
  }

  const requestError = classifyRequestError(error)
  if (requestError.kind === 'network' || isAbortError(error) || (error instanceof AgentRuntimeError && error.code === 'client_agent_connection')) {
    return {
      category: 'network',
      diagnosticCode: 'BACKEND_NETWORK_TIMEOUT',
      error: {
        kind: 'network',
        title: '无法连接后端服务',
        message: `启动检测在“${stageLabel}”阶段未收到响应，请检查网络或本机服务状态后重试。`,
        status: requestError.status,
      },
      stage,
      stageLabel,
    }
  }

  const readiness = stage === 'readiness'
  return {
    category: 'service',
    diagnosticCode: readiness ? 'BACKEND_READY_TIMEOUT' : 'BACKEND_HEALTH_TIMEOUT',
    error: {
      kind: 'unavailable',
      title: readiness ? '本机 Agent服务尚未就绪' : '本机 Agent连接超时',
      message: readiness
        ? '本机 Agent已响应，但运行环境未通过就绪检查。请稍后重试；若持续失败，请检查本机 Agent 公共配置和配套公钥。'
        : '未能在限定时间内连接本机 Agent，请检查网络与服务状态后重试。',
      status: requestError.status,
    },
    stage,
    stageLabel,
  }
}
