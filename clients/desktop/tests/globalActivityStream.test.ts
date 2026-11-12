/**
 * 全局活动流（SSE）重连契约。
 *
 * 打包真实的 `src/api/agent/globalEvents.ts`（esbuild + 依赖 stub），确认服务端正常结束流（EOF，
 * 如 Agent 重启、代理空闲关闭）后客户端会自动重连，并且每次连接成功都会通知上层，
 * 让上层在重连后刷新会话列表、补齐断连期间漏掉的信号。
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

const STUBS: Record<string, string> = {
  './client': `export class AgentApiError extends Error {
    constructor(message, status, details) { super(message); this.status = status; this.code = details?.code }
  }`,
  './runtime': `export const pickAgentFetch = async () => globalThis.fetch`,
  '../backend/config': `export const resolveBackendBaseUrl = async () => 'http://127.0.0.1:9999'`,
}

async function loadModule(dir: string): Promise<{ subscribeGlobalActivity: (options: any) => { close(): void; readonly isClosed: boolean } }> {
  const outfile = join(dir, 'globalEvents.cjs')
  await build({
    entryPoints: ['src/api/agent/globalEvents.ts'], outfile, bundle: true, platform: 'node', format: 'cjs',
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
  return require(outfile)
}

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

test('服务端正常结束全局活动流后会自动重连，且每次连接成功都通知上层', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'global-activity-'))
  try {
    const { subscribeGlobalActivity } = await loadModule(dir)
    const activity = {
      type: 'prompt_settled', conversation_id: 'conv-1', employee_id: null, tenant_id: null, member_id: null,
      outcome: 'ok', last_preview: 'hi', last_message_at: '2026-01-01T00:00:00Z', assistant_message_count: 1,
    }
    const responses = [sseResponse(': connected\n\n'), sseResponse(`: connected\n\nevent: activity\ndata: ${JSON.stringify(activity)}\n\n`)]
    let fetchCount = 0
    const fetchImpl = async () => {
      fetchCount += 1
      return responses[Math.min(fetchCount - 1, responses.length - 1)]!.clone()
    }
    let connected = 0
    let closed = 0
    const events: unknown[] = []
    const subscription = subscribeGlobalActivity({
      fetchImpl,
      onConnected: () => { connected += 1 },
      onClose: () => { closed += 1 },
      onEvent: (event: unknown) => { events.push(event) },
    })
    try {
      const deadline = Date.now() + 5000
      while (events.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
      assert.ok(fetchCount >= 2, `EOF 之后应重连，实际请求 ${fetchCount} 次`)
      assert.ok(connected >= 2, '重连成功后必须再次通知上层，用于刷新会话列表')
      assert.ok(closed >= 1, '服务端结束流时应通知 onClose')
      assert.equal(events.length, 1)
      assert.equal((events[0] as { conversation_id: string }).conversation_id, 'conv-1')
    } finally {
      subscription.close()
    }
    assert.equal(subscription.isClosed, true)
    const after = fetchCount
    await new Promise((resolve) => setTimeout(resolve, 900))
    assert.equal(fetchCount, after, 'close() 之后不应再重连')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
