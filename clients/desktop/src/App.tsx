import { lazy, Suspense, useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import CommandPalette from './components/Layout/CommandPalette'
import ConversationHistorySearch from './components/Layout/ConversationHistorySearch'
import GlobalShortcuts from './components/Layout/GlobalShortcuts'
import { useAgentAuthStore } from './stores/agentAuth'
import { useNetworkStatus } from './hooks/useNetwork'
import OfflineOverlay from './components/OfflineOverlay'
import GrantsSyncNotice from './components/GrantsSyncNotice'
import RechargePromptDialog from './components/Billing/RechargePromptDialog'
import ApprovalDialog from './components/Approvals/ApprovalDialog'
import BackendStartupScreen from './components/AppRecovery/BackendStartupScreen'
import { createSafeDiagnostic, type SafeDiagnostic } from './lib/appDiagnostics'
import {
  classifyBackendStartupFailure,
  isBackendStartupConfigurationError,
  type BackendStartupFailure,
  type BackendStartupStage,
} from './lib/backendStartup'
// 桌面由宿主启动并检查本地 Agent；浏览器开发通过 Vite 代理检查服务。
import { AgentApiClient } from './api/agent/client'
import { initializeAgentRuntime, isTauri } from './api/agent/runtime'

const Chat = lazy(() => import('./pages/Chat'))
const GroupChat = lazy(() => import('./pages/GroupChat'))
const AgentConfig = lazy(() => import('./pages/AgentConfig'))
const TalentMarket = lazy(() => import('./pages/TalentMarket'))
const SkillCenter = lazy(() => import('./pages/SkillCenter'))
const OrgChart = lazy(() => import('./pages/OrgChart'))
const Workbench = lazy(() => import('./pages/Workbench'))
const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase'))
const KnowledgeBaseDetail = lazy(() => import('./pages/KnowledgeBase/Detail'))
const McpConfig = lazy(() => import('./pages/McpConfig'))
const OfficeStatus = lazy(() => import('./pages/OfficeStatus'))
const Settings = lazy(() => import('./pages/Settings'))
const Profile = lazy(() => import('./pages/Profile'))
const Tasks = lazy(() => import('./pages/AutoTasks'))
const Login = lazy(() => import('./pages/Login'))
// 办公室常驻运行时（Pixi / Spine）单独分包：登录后在后台加载，不拖慢首屏
const OfficeRuntimeHost = lazy(() => import('./components/OfficeRuntimeHost'))

const BACKEND_POLL_INTERVAL_MS = 500
const BACKEND_POLL_TIMEOUT_MS = 90_000
const BACKEND_PROBE_TIMEOUT_MS = 3_000

interface BackendProbeResponse {
  ready?: boolean
  status?: string
}

type BackendStartupResult =
  | { ok: true }
  | { ok: false; failure: BackendStartupFailure }

function RouteLoading() {
  return <div className="route-loading" role="status" aria-live="polite">正在加载页面…</div>
}

// 独立的启动检查 client:不需要 Bearer,不需要 401 登出;只轮询 /healthz 与 /readyz。
// 延迟创建才能把非法 API 地址等构造错误收敛到可诊断配置错误页。
let startupClient: AgentApiClient | null = null

function getStartupClient(): AgentApiClient {
  if (!startupClient) startupClient = new AgentApiClient({})
  return startupClient
}

// Agent Runtime 的健康检查端点(v1 三端架构):
//   /healthz  → 进程存活
//   /readyz   → 运行环境可用
async function probeBackend(path: '/healthz' | '/readyz', signal: AbortSignal): Promise<BackendProbeResponse> {
  const controller = new AbortController()
  const handleAbort = () => controller.abort()
  signal.addEventListener('abort', handleAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), BACKEND_PROBE_TIMEOUT_MS)
  try {
    return await getStartupClient().request<BackendProbeResponse>({
      method: 'GET',
      path,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', handleAbort)
  }
}

function isSuccessfulProbe(response: BackendProbeResponse): boolean {
  return response.status === 'ok' || response.status === 'ready' || response.ready === true
}

async function waitForPollInterval(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const handleDone = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', handleDone)
      resolve()
    }
    const timer = setTimeout(handleDone, BACKEND_POLL_INTERVAL_MS)
    signal.addEventListener('abort', handleDone, { once: true })
  })
}

async function waitForBackendReady(
  signal: AbortSignal,
  onStageChange: (stage: BackendStartupStage) => void,
): Promise<BackendStartupResult> {
  if (isTauri()) {
    try {
      await initializeAgentRuntime()
      return { ok: true }
    } catch (error) {
      return { ok: false, failure: classifyBackendStartupFailure(error, 'health') }
    }
  }
  const start = Date.now()
  let stage: BackendStartupStage = 'health'
  let healthConfirmed = false
  let lastError: unknown = { code: 'backend_start_timeout' }

  while (!signal.aborted) {
    try {
      if (!healthConfirmed) {
        const health = await probeBackend('/healthz', signal)
        if (!isSuccessfulProbe(health)) throw { code: 'backend_health_not_ok' }
        healthConfirmed = true
        stage = 'readiness'
        onStageChange(stage)
      }

      const readiness = await probeBackend('/readyz', signal)
      if (isSuccessfulProbe(readiness)) return { ok: true }
      lastError = { code: 'backend_not_ready' }
    } catch (error) {
      lastError = error
      if (isBackendStartupConfigurationError(error)) {
        return { ok: false, failure: classifyBackendStartupFailure(error, stage) }
      }
    }

    if (Date.now() - start > BACKEND_POLL_TIMEOUT_MS) {
      return { ok: false, failure: classifyBackendStartupFailure(lastError, stage) }
    }
    await waitForPollInterval(signal)
  }

  return { ok: false, failure: classifyBackendStartupFailure(lastError, stage) }
}

function ProtectedRoutes() {
  return (
    <Layout>
      <RechargePromptDialog />
      <ApprovalDialog />
      <Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route path="/chat/:id?" element={<Chat />} />
          <Route path="/group-chat" element={<GroupChat />} />
          <Route path="/tasks" element={<Tasks />} />
          {/* 员工详情中的自动化任务入口使用语义化路径，保留 /tasks 作为导航兼容路径。 */}
          <Route path="/auto-tasks" element={<Tasks />} />
          <Route path="/agents" element={<AgentConfig />} />
          <Route path="/talents" element={<TalentMarket />} />
          <Route path="/skills" element={<SkillCenter />} />
          <Route path="/knowledge" element={<KnowledgeBase />} />
          <Route path="/knowledge/local-documents" element={<KnowledgeBase />} />
          <Route path="/knowledge/:id" element={<KnowledgeBaseDetail />} />
          <Route path="/workbench" element={<Workbench />} />
          <Route path="/org" element={<OrgChart />} />
          <Route path="/mcp" element={<McpConfig />} />
          <Route path="/office" element={<OfficeStatus />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  )
}

export default function App() {
  // 新栈 auth(agent JWT + tenant_id + account)是登录鉴权的事实源。
  // Agent Bearer 会话恢复必须独立于后端健康检查启动，确保离线启动时也会
  // 立即迁移并清理 WebView 中的旧 JWT。
  const isAuthenticated = useAgentAuthStore((s) => s.isAuthenticated)
  const isRestoring = useAgentAuthStore((s) => s.isRestoring)
  const sessionGeneration = useAgentAuthStore((s) => s.sessionGeneration)
  const restoreAgentSession = useAgentAuthStore((s) => s.restoreSession)
  const isOnline = useNetworkStatus()
  const [backendReady, setBackendReady] = useState(false)
  const [backendStage, setBackendStage] = useState<BackendStartupStage>('health')
  const [backendFailure, setBackendFailure] = useState<BackendStartupFailure | null>(null)
  const [backendDiagnostic, setBackendDiagnostic] = useState<SafeDiagnostic | null>(null)
  const [backendCheckAttempt, setBackendCheckAttempt] = useState(0)

  useEffect(() => {
    void restoreAgentSession()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const controller = new AbortController()
    setBackendReady(false)
    setBackendStage('health')
    setBackendFailure(null)
    setBackendDiagnostic(null)
    waitForBackendReady(controller.signal, setBackendStage).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) {
        setBackendReady(true)
      } else {
        setBackendFailure(result.failure)
        setBackendDiagnostic(createSafeDiagnostic({
          code: result.failure.diagnosticCode,
          stage: result.failure.stage,
          category: result.failure.category,
          pathname: window.location.pathname,
        }))
      }
    })
    return () => controller.abort()
  }, [backendCheckAttempt])

  const handleBackendRetry = () => {
    setBackendFailure(null)
    setBackendDiagnostic(null)
    setBackendCheckAttempt((attempt) => attempt + 1)
  }

  if (!backendReady) {
    return (
      <>
        <GlobalShortcuts />
        <BackendStartupScreen
          diagnostic={backendDiagnostic}
          failure={backendFailure}
          onRetry={handleBackendRetry}
          stage={backendStage}
          stageLabel={isTauri() ? '启动本地 Agent' : undefined}
        />
      </>
    )
  }

  if (isRestoring) {
    return (
      <div
        data-tauri-drag-region
        className="app-window"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}
      >
        <GlobalShortcuts />
        <div style={{ fontSize: 14, opacity: 0.7 }}>正在恢复登录状态…</div>
      </div>
    )
  }

  return (
    <div className="app-window">
      <GlobalShortcuts />
      {!isOnline && <OfflineOverlay />}
      {isAuthenticated && <CommandPalette />}
      {isAuthenticated && <GrantsSyncNotice key={sessionGeneration} />}
      {isAuthenticated && <ConversationHistorySearch />}
      {isAuthenticated && (
        <Suspense fallback={null}>
          <OfficeRuntimeHost key={sessionGeneration} />
        </Suspense>
      )}
      <Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/profile/:tab?" element={isAuthenticated ? <Profile /> : <Navigate to="/login" replace />} />
          <Route
            path="/*"
            element={isAuthenticated ? <ProtectedRoutes /> : <Navigate to="/login" replace />}
          />
        </Routes>
      </Suspense>
    </div>
  )
}
