import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativeHttpFetch } from '../src/api/agent/nativeHttpFetch.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function nativeMock(options: { status?: number; read?: () => Promise<number[]>; send?: () => Promise<void> } = {}) {
  const calls: string[] = []
  const reading = deferred<void>()
  const sending = deferred<void>()
  let reads = 0
  const fetch = createNativeHttpFetch(async <T>(command: string) => {
    calls.push(command)
    if (command.endsWith('|fetch')) return 10 as T
    if (command.endsWith('|fetch_send')) {
      sending.resolve()
      await options.send?.()
      return { status: options.status ?? 200, statusText: 'OK', url: 'http://localhost/test', headers: [['content-type', 'text/plain']], rid: 20 } as T
    }
    if (command.endsWith('|fetch_read_body')) {
      reading.resolve()
      if (options.read) return await options.read() as T
      return (reads++ === 0 ? [111, 107, 0] : [1]) as T
    }
    // Model a RID already released by concurrent native completion.
    if (command.includes('cancel')) throw new Error('The resource id 20 is invalid.')
    throw new Error(`Unexpected command ${command}`)
  })
  return { fetch, calls, reading: reading.promise, sending: sending.promise }
}

test('aborting a completed response never cancels released request or body resources', async () => {
  const mock = nativeMock()
  const controller = new AbortController()
  const response = await mock.fetch('http://localhost/test', { signal: controller.signal })
  assert.equal(await response.text(), 'ok')
  controller.abort()
  assert.equal(mock.calls.filter(call => call.includes('cancel')).length, 0)
})

test('SSE abort cancels its body once and absorbs an in-flight read failure', async () => {
  const pending = deferred<number[]>()
  const mock = nativeMock({ read: () => pending.promise })
  const controller = new AbortController()
  const response = await mock.fetch('http://localhost/test', { signal: controller.signal })
  const result = response.text()
  await mock.reading
  controller.abort()
  pending.reject(new Error('The resource id 20 is invalid.'))
  await assert.rejects(result, { name: 'AbortError' })
  assert.deepEqual(mock.calls.filter(call => call.includes('cancel')), ['plugin:http|fetch_cancel_body'])
})

test('body cancellation followed by abort does not release a resource twice', async () => {
  const pending = deferred<number[]>()
  const mock = nativeMock({ read: () => pending.promise })
  const controller = new AbortController()
  const response = await mock.fetch('http://localhost/test', { signal: controller.signal })
  await mock.reading
  await response.body!.cancel()
  controller.abort()
  pending.resolve([1])
  assert.equal(mock.calls.filter(call => call.includes('cancel')).length, 1)
})

test('abort during send handles both request cancellation and a late response', async () => {
  const pending = deferred<void>()
  const mock = nativeMock({ send: () => pending.promise })
  const controller = new AbortController()
  const result = mock.fetch('http://localhost/test', { signal: controller.signal })
  await mock.sending
  controller.abort()
  pending.resolve()
  await assert.rejects(result, { name: 'AbortError' })
  assert.deepEqual(mock.calls.filter(call => call.includes('cancel')), ['plugin:http|fetch_cancel', 'plugin:http|fetch_cancel_body'])
})

test('null-body responses release the native response and detach cancellation', async () => {
  const mock = nativeMock({ status: 204 })
  const controller = new AbortController()
  const response = await mock.fetch('http://localhost/test', { signal: controller.signal })
  assert.equal(response.body, null)
  controller.abort()
  assert.deepEqual(mock.calls.filter(call => call.includes('cancel')), ['plugin:http|fetch_cancel_body'])
})

test('read failures remain visible while cleanup failures are handled', async () => {
  const mock = nativeMock({ read: async () => { throw new Error('connection lost') } })
  const response = await mock.fetch('http://localhost/test')
  await assert.rejects(response.text(), /connection lost/)
  assert.equal(mock.calls.filter(call => call.includes('cancel')).length, 1)
})

test('an already aborted request never allocates native resources', async () => {
  const mock = nativeMock()
  await assert.rejects(mock.fetch('http://localhost/test', { signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.deepEqual(mock.calls, [])
})

test('native transport preserves JSON writes, authorization and binary response bytes', async () => {
  let reads = 0
  const fetch = createNativeHttpFetch(async <T>(command: string, args: Record<string, unknown>) => {
    if (command.endsWith('|fetch')) {
      const config = args.clientConfig as { method: string; headers: [string, string][]; data: number[] }
      assert.equal(config.method, 'POST')
      assert.equal(new Headers(config.headers).get('authorization'), 'Bearer test-token')
      assert.equal(new Headers(config.headers).get('content-type'), 'application/json')
      assert.equal(new TextDecoder().decode(new Uint8Array(config.data)), '{"title":"群聊"}')
      return 10 as T
    }
    if (command.endsWith('|fetch_send')) return {
      status: 200, statusText: 'OK', url: 'http://localhost/test',
      headers: [['content-type', 'application/octet-stream']], rid: 20,
    } as T
    if (command.endsWith('|fetch_read_body')) return new Uint8Array(reads++ ? [1] : [0, 255, 128, 0]).buffer as T
    throw new Error(`Unexpected command ${command}`)
  })
  const response = await fetch('http://localhost/test', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: '{"title":"群聊"}',
  })
  assert.equal(response.url, 'http://localhost/test')
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 255, 128]))
})
