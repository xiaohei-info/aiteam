import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/globals.css'
import FileAccessGate from './components/FileAccess/FileAccessGate'
import App from './App'
import GlobalErrorBoundary from './components/AppRecovery/GlobalErrorBoundary'
import { initializeApplicationLogging } from './lib/desktopLogging'
import { usesWindowsWindowControls } from './lib/windowChrome'
import { startNativeFileDrop } from './lib/nativeFileDrop'

initializeApplicationLogging()
// 让样式知道要避让右上角自绘的 Windows 窗口控件（见 globals.css 的 .topbar 侧内边距）。
if (usesWindowsWindowControls(navigator.userAgent)) document.documentElement.dataset.windowChrome = 'windows'

// 从访达/资源管理器拖进窗口的文件由 Tauri 原生拖放接住（按路径交给输入栏，落在别处忽略）。
void startNativeFileDrop().catch((error) => console.error('[nativeFileDrop] listen failed:', error))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GlobalErrorBoundary>
      <BrowserRouter future={{ v7_startTransition: true }}>
        <App />
        <FileAccessGate />
      </BrowserRouter>
    </GlobalErrorBoundary>
  </React.StrictMode>,
)
