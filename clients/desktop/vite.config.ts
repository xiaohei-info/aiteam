import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import { assertSecureApiUrl } from './src/api/urlSecurity'
import { TEST_AGENT_BASE_URL, DEPLOYED_AGENT_HTTP_ORIGINS } from './src/api/agent/config'
import { isDocumentedRequest } from './src/api/agent/contract'
import { createSafeRequestMetadata } from './src/api/requestLogging'
import { officeEditorVitePlugin } from './scripts/office-editor-middleware.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const host = process.env.TAURI_DEV_HOST
function logProxyTarget(target: string): NonNullable<ProxyOptions['configure']> {
  return (proxy) => {
    proxy.on('proxyReq', (outgoing) => {
      const metadata = createSafeRequestMetadata({
        method: outgoing.method,
        url: new URL(outgoing.path, target).href,
        hasBody: outgoing.hasHeader('content-type'),
      })
      console.info(`[Vite proxy] ${metadata.method} ${metadata.url}`)
    })
  }
}
function documentedProxyRequest(prefix = ''): NonNullable<ProxyOptions['bypass']> {
  return (request) => {
    const pathname = (request.url ?? '').split('?')[0].slice(prefix.length)
    return isDocumentedRequest(request.method ?? 'GET', pathname) ? undefined : false
  }
}
// Tauri dev/prod both discover the sidecar through IPC and use native HTTP.
// Browser development can override the TEST Agent proxy with an explicitly started local Agent.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '')
  const apiBaseUrl = assertSecureApiUrl(
    env.VITE_AGENT_BASE_URL ?? env.VITE_API_BASE_URL ?? TEST_AGENT_BASE_URL,
    'Vite API 代理',
    DEPLOYED_AGENT_HTTP_ORIGINS,
  )
  const backendBaseUrl = assertSecureApiUrl(env.VITE_BACKEND_BASE_URL || TEST_AGENT_BASE_URL, '后台 API 代理', DEPLOYED_AGENT_HTTP_ORIGINS)
  return {
    plugins: [react(), officeEditorVitePlugin({ aiteamRoot: __dirname })],
    clearScreen: false,
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
      watch: { ignored: ['**/src-tauri/**'] },
      // dev 模式所有走 Agent 的路径都必须被 proxy 转发。若漏配,vite 会把请求当作 SPA
      // 路由,返回 index.html —— axios 收到 HTML 会解析出 `data keys: 0,1,2,...` 的字符串索引,
      // 表面上返回 200 但实际业务永远失败。
      proxy: {
        // 后台业务独立于本机 Agent 地址。
        '/backend-api': { bypass: documentedProxyRequest('/backend-api'), target: backendBaseUrl, changeOrigin: true, rewrite: path => path.replace(/^\/backend-api/, ''), configure: logProxyTarget(backendBaseUrl) },
        // 健康检查两端(启动前轮询 /healthz,登录/授权时校验 /readyz)。
        '/healthz': { bypass: documentedProxyRequest(), target: apiBaseUrl, changeOrigin: true, configure: logProxyTarget(apiBaseUrl) },
        '/readyz': { bypass: documentedProxyRequest(), target: apiBaseUrl, changeOrigin: true, configure: logProxyTarget(apiBaseUrl) },
        // 本机 Agent 业务走 /api；后台业务走上面的 /backend-api。
        '/api': {
          bypass: documentedProxyRequest(),
          target: apiBaseUrl,
          changeOrigin: true,
          timeout: 0,
          configure: (proxy, options) => {
            logProxyTarget(apiBaseUrl)(proxy, options)
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.removeHeader('Origin')
              proxyReq.removeHeader('Referer')
            })
            proxy.on('proxyRes', (proxyRes, req) => {
              if (req.url?.includes('/stream') || req.url?.includes('/events')) {
                proxyRes.headers['content-type'] = 'text/event-stream'
                proxyRes.headers['x-accel-buffering'] = 'no'
                proxyRes.headers['cache-control'] = 'no-cache'
                proxyRes.headers['connection'] = 'keep-alive'
              }
            })
          },
        },
      },
    },
  }
})
