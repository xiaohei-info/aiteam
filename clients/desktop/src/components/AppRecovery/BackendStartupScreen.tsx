import './AppRecovery.css'
import RequestErrorState from '../RequestState/RequestErrorState'
import type { SafeDiagnostic } from '../../lib/appDiagnostics'
import { BACKEND_STAGE_LABELS, type BackendStartupFailure, type BackendStartupStage } from '../../lib/backendStartup'
import MacWindowControls from '../Layout/MacWindowControls'
import DiagnosticPanel from './DiagnosticPanel'

interface BackendStartupScreenProps {
  diagnostic: SafeDiagnostic | null
  failure: BackendStartupFailure | null
  onRetry: () => void
  stage: BackendStartupStage
  stageLabel?: string
}

export default function BackendStartupScreen({
  diagnostic,
  failure,
  onRetry,
  stage,
  stageLabel = BACKEND_STAGE_LABELS[stage],
}: BackendStartupScreenProps) {
  return (
    <div data-tauri-drag-region className="app-window app-recovery relative">
      <header
        data-tauri-drag-region
        className="absolute inset-x-0 top-0 z-20 flex h-12 items-center px-4"
        aria-label="窗口控制栏"
      >
        <MacWindowControls />
      </header>
      <main className="app-recovery-card">
        <p className="app-recovery-kicker">启动阶段 · {failure?.stageLabel ?? stageLabel}</p>
        {failure && diagnostic ? (
          <>
            <RequestErrorState error={failure.error} onRetry={onRetry} retryLabel="重新检测" />
            <DiagnosticPanel diagnostic={diagnostic} />
          </>
        ) : (
          <div className="app-startup-progress" role="status">
            <span aria-hidden="true" />
            正在{stageLabel}…
          </div>
        )}
      </main>
    </div>
  )
}
