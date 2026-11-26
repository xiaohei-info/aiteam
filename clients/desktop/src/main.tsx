import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/globals.css'
import FileAccessGate from './components/FileAccess/FileAccessGate'
import App from './App'
import GlobalErrorBoundary from './components/AppRecovery/GlobalErrorBoundary'
import { initializeApplicationLogging } from './lib/desktopLogging'
import { usesWindowsWindowControls } from './lib/windowChrome'

initializeApplicationLogging()
// 让样式知道要避让右上角自绘的 Windows 窗口控件（见 globals.css 的 .topbar 侧内边距）。
if (usesWindowsWindowControls(navigator.userAgent)) document.documentElement.dataset.windowChrome = 'windows'

// 窗口关掉了 Tauri 的原生拖放（dragDropEnabled:false）后，文件落在没有接收区的地方时 WebView
// 会直接打开这个文件、整个应用页面被换掉。输入栏之外的拖放一律吞掉；输入栏自己会先处理。
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (event) => {
    if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault()
  })
}

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
