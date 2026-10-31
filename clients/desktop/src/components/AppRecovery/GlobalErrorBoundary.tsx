import { Component, Fragment, type ReactNode } from 'react'
import { LogIn, RotateCcw } from 'lucide-react'
import './AppRecovery.css'
import RequestErrorState from '../RequestState/RequestErrorState'
import { createRenderDiagnostic, type SafeDiagnostic } from '../../lib/appDiagnostics'
import DiagnosticPanel from './DiagnosticPanel'
import { recordApplicationLog } from '../../lib/applicationLog'

interface GlobalErrorBoundaryProps {
  children: ReactNode
}

interface GlobalErrorBoundaryState {
  diagnostic: SafeDiagnostic | null
  hasError: boolean
  resetKey: number
}

export default class GlobalErrorBoundary extends Component<
  GlobalErrorBoundaryProps,
  GlobalErrorBoundaryState
> {
  state: GlobalErrorBoundaryState = {
    diagnostic: null,
    hasError: false,
    resetKey: 0,
  }

  static getDerivedStateFromError(): Partial<GlobalErrorBoundaryState> {
    return {
      diagnostic: createRenderDiagnostic(window.location.pathname),
      hasError: true,
    }
  }

  componentDidCatch(): void {
    recordApplicationLog('error', 'ui.render_failed', { code: 'UI_RENDER_FAILURE' })
  }

  private handleRetry = () => {
    this.setState((state) => ({
      diagnostic: null,
      hasError: false,
      resetKey: state.resetKey + 1,
    }))
  }

  private handleRestart = () => {
    window.location.reload()
  }

  private handleReturnToLogin = () => {
    window.location.assign('/login')
  }

  render() {
    if (this.state.hasError) {
      const diagnostic = this.state.diagnostic ?? createRenderDiagnostic()
      return (
        <div className="app-window app-recovery">
          <main className="app-recovery-card">
            <p className="app-recovery-kicker">应用恢复</p>
            <RequestErrorState
              error={{
                kind: 'unknown',
                title: '页面遇到异常',
                message: '界面未能安全完成渲染。你的账号凭据和错误堆栈不会显示在此页面。',
              }}
              onRetry={this.handleRetry}
              retryLabel="重新渲染"
            />
            <DiagnosticPanel diagnostic={diagnostic} />
            <div className="app-recovery-actions">
              <button className="app-recovery-action secondary" type="button" onClick={this.handleReturnToLogin}>
                <LogIn size={14} />
                返回登录
              </button>
              <button className="app-recovery-action" type="button" onClick={this.handleRestart}>
                <RotateCcw size={14} />
                重启启动检测
              </button>
            </div>
          </main>
        </div>
      )
    }

    return <Fragment key={this.state.resetKey}>{this.props.children}</Fragment>
  }
}
