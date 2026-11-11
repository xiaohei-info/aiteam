/**
 * 会话事件流（SSE）请求契约。
 *
 * 这里打包真实的 `src/api/agent/events.ts`（esbuild + 依赖 stub），确认它发出的请求
 * 带有 reconciliation v2 头。缺这个头时服务端按 v1 返回、不含 `active_runs`，
 * 前端占位气泡拿不到 work_id/身份，会与 reconciliation 里已持久化的回复条目
 * 匹配不上，出现「同一个回答显示两条、run 结束后再合并成一条」的问题。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { build } = await import(pathToFileURL(require.resolve('esbuild', { paths: [dirname(require.resolve('vite'))] })).href)

// 只 stub 依赖 Tauri / import.meta.env 的模块；其余（contract、urlSecurity、applicationLog 等）走真实实现。
const STUBS: Record<string, string> = {
  './client': `export class AgentApiError extends Error {
    constructor(message, status, details) { super(message); this.status = status; this.code = details?.code }
  }`,
  './runtime': `export const pickAgentFetch = async () => globalThis.fetch`,
  '../backend/config': `export const resolveBackendBaseUrl = async () => 'http://127.0.0.1:9999'`,
}

interface Captured {
  url: string
  headers: Record<string, string>
}

test('会话事件流请求带 reconciliation v2 头与断线续读游标', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-stream-'))
  const outfile = join(dir, 'events.cjs')
  try {
    await build({
      entryPoints: ['src/api/agent/events.ts'], outfile, bundle: true, platform: 'node', format: 'cjs',
      plugins: [{ name: 'stubs', setup(b: any) {
        b.onResolve({ filter: /^\.\.?\// }, (a: any) => {
          if (a.kind === 'entry-point' || !(a.path in STUBS)) return undefined
          return { path: a.path, namespace: 'stub' }
        })
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a: any) => ({
          contents: STUBS[a.path], loader: 'js', resolveDir: process.cwd(),
        }))
      } }],
    })
    const captured: Captured[] = []
    const events = (await import(pathToFileURL(outfile).href)) as {
      subscribeConversationEvents: (options: Record<string, unknown>) => { close(): void }
    }
    const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
      captured.push({ url, headers: init.headers })
      // 空流立即 EOF：runStream 正常结束，runWithReconnect 不重连。
      return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    const subscription = events.subscribeConversationEvents({
      conversationId: 'conv-1',
      after: 'evt-9',
      fetchImpl,
      onEvent: () => {},
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(captured.length, 1)
      assert.equal(captured[0]!.headers['X-Aiteam-Reconciliation-Version'], '2')
      assert.equal(captured[0]!.headers['Last-Event-ID'], 'evt-9')
      assert.equal(captured[0]!.headers.Accept, 'text/event-stream')
      assert.match(captured[0]!.url, /\/api\/agent\/conversations\/conv-1\/events\?after=evt-9$/)
    } finally {
      subscription.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
