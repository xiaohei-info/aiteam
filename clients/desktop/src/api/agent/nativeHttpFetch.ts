/** Tauri HTTP 2.5.9 IPC with explicit ownership of cancellation and body RIDs. */
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>

interface NativeResponse {
  status: number
  statusText: string
  url: string
  headers: [string, string][]
  rid: number
}

export function createNativeHttpFetch(invoke: Invoke): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const signal = request.signal
    const aborted = () => new DOMException('The request was aborted.', 'AbortError')
    signal.throwIfAborted()
    const buffer = await request.arrayBuffer()
    signal.throwIfAborted()
    const rid = await invoke<number>('plugin:http|fetch', {
      clientConfig: {
        method: request.method,
        url: request.url,
        headers: Array.from(request.headers.entries()),
        data: buffer.byteLength ? Array.from(new Uint8Array(buffer)) : null,
      },
    })
    // Cleanup may race native EOF/abort. Always observe its promise.
    const cancelRequest = () => {
      void invoke('plugin:http|fetch_cancel', { rid }).catch(() => {})
    }
    signal.addEventListener('abort', cancelRequest, { once: true })
    if (signal.aborted) cancelRequest()
    let response: NativeResponse
    try {
      response = await invoke<NativeResponse>('plugin:http|fetch_send', { rid })
    } catch (error) {
      throw signal.aborted ? aborted() : error
    } finally {
      signal.removeEventListener('abort', cancelRequest)
    }

    let finished = false
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    const finish = () => {
      finished = true
      signal.removeEventListener('abort', cancelBody)
    }
    const dropBody = async () => {
      if (finished) return
      finish()
      await invoke('plugin:http|fetch_cancel_body', { rid: response.rid }).catch(() => {})
    }
    const cancelBody = () => {
      if (finished) return
      bodyController?.error(aborted())
      void dropBody()
    }
    if (signal.aborted) {
      await dropBody()
      throw aborted()
    }
    const hasBody = ![101, 103, 204, 205, 304].includes(response.status)
    const body = hasBody ? new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller
        signal.addEventListener('abort', cancelBody, { once: true })
      },
      async pull(controller) {
        try {
          const chunk = new Uint8Array(await invoke<ArrayBuffer | number[]>('plugin:http|fetch_read_body', { rid: response.rid }))
          if (finished) return
          if (chunk[chunk.length - 1] === 1) {
            // Native EOF already closes the response RID.
            finish()
            controller.close()
          } else {
            controller.enqueue(chunk.slice(0, -1))
          }
        } catch (error) {
          if (finished) return
          controller.error(error)
          await dropBody()
        }
      },
      cancel: dropBody,
    }) : null
    if (!hasBody) await dropBody()
    const result = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    Object.defineProperty(result, 'url', { value: response.url })
    return result
  }
}
