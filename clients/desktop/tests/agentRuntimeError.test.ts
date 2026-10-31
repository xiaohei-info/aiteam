import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeAgentRuntimeError } from '../src/lib/agentRuntimeError.ts'
import { classifyBackendStartupFailure, isBackendStartupConfigurationError } from '../src/lib/backendStartup.ts'
import { createSafeDiagnostic, formatSafeDiagnostic } from '../src/lib/appDiagnostics.ts'

test('missing distribution and outdated native host have distinct actionable diagnostics', () => {
  const missing = classifyBackendStartupFailure(normalizeAgentRuntimeError('未安装新版本机 Agent 包及企业公共配置，请安装包含完整 agent 资源目录的客户端'), 'health')
  const oldHost = classifyBackendStartupFailure(normalizeAgentRuntimeError('Command get_agent_base_url not found'), 'health')
  assert.equal(missing.diagnosticCode, 'BACKEND_AGENT_NOT_INSTALLED')
  assert.match(missing.error.message, /src-tauri\/resources\/agent/)
  assert.equal(oldHost.diagnosticCode, 'BACKEND_HOST_RESTART_REQUIRED')
  assert.match(oldHost.error.message, /前端热更新不能更新原生命令/)
  const copied = formatSafeDiagnostic(createSafeDiagnostic({ code: missing.diagnosticCode, category: missing.category, stage: missing.stage }))
  assert.match(copied, /code=BACKEND_AGENT_NOT_INSTALLED/)
})

test('native readiness and connection failures are retryable and retain the failing stage', () => {
  const readyError = normalizeAgentRuntimeError('本机进程已启动，但运行环境尚未就绪')
  const connectionError = normalizeAgentRuntimeError('本机 Agent 尚未响应')
  assert.equal(isBackendStartupConfigurationError(readyError), false)
  assert.equal(isBackendStartupConfigurationError(connectionError), false)
  const ready = classifyBackendStartupFailure(readyError, 'health')
  assert.equal(ready.stage, 'readiness')
  assert.equal(ready.diagnosticCode, 'BACKEND_READY_TIMEOUT')
  assert.equal(classifyBackendStartupFailure(connectionError, 'health').category, 'network')
})

test('unknown IPC and configuration errors do not expose arbitrary native details', () => {
  const secret = 'password=secret /private/customer/path'
  const normalized = normalizeAgentRuntimeError(new Error(secret))
  const error = Object.assign(new Error(secret), { code: 'client_insecure_api_url' })
  assert.doesNotMatch(normalized.message, /password|customer/)
  assert.doesNotMatch(classifyBackendStartupFailure(error, 'health').error.message, /password|customer/)
})
