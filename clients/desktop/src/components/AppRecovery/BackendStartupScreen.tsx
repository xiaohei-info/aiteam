import { getCurrentWindow } from '@tauri-apps/api/window'
import './AppRecovery.css'
import RequestErrorState from '../RequestState/RequestErrorState'
import type { SafeDiagnostic } from '../../lib/appDiagnostics'
import { BACKEND_STAGE_LABELS, type BackendStartupFailure, type BackendStartupStage } from '../../lib/backendStartup'
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
        <div className="flex items-center gap-[7px]">
          <button
            type="button"
            onClick={() => getCurrentWindow().close()}
            className="h-[12px] w-[12px] flex-shrink-0 cursor-pointer rounded-full border border-[#e0443e]/40 bg-[#ff5f57] shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors duration-150 hover:bg-[#ff3b30]"
            title="关闭"
            aria-label="关闭窗口"
          />
          <button
            type="button"
            onClick={() => getCurrentWindow().minimize()}
            className="h-[12px] w-[12px] flex-shrink-0 cursor-pointer rounded-full border border-[#dea123]/40 bg-[#febc2e] shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors duration-150 hover:bg-[#f5a623]"
            title="最小化"
            aria-label="最小化窗口"
          />
          <button
            type="button"
            onClick={() => getCurrentWindow().toggleMaximize()}
            className="h-[12px] w-[12px] flex-shrink-0 cursor-pointer rounded-full border border-[#1aab29]/40 bg-[#28c840] shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors duration-150 hover:bg-[#1db934]"
            title="最大化 / 还原"
            aria-label="切换窗口最大化"
          />
        </div>
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
