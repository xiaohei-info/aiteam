import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/globals.css'
import FileAccessGate from './components/FileAccess/FileAccessGate'
import App from './App'
import GlobalErrorBoundary from './components/AppRecovery/GlobalErrorBoundary'
import { initializeApplicationLogging } from './lib/desktopLogging'

initializeApplicationLogging()

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
