import { useCallback, useEffect, useRef, useState } from 'react'

export interface VoiceRecording {
  base64: string
  mimeType: string
  durationMs: number
}

export interface UseVoiceInputOptions {
  /** 录音达到时长上限时自动收尾并回调（默认上限 60s）。 */
  onAutoStop?: (recording: VoiceRecording) => void
}

const MIN_DURATION_MS = 500
const MAX_DURATION_MS = 60_000
const TICK_INTERVAL_MS = 200
const AUDIO_BITS_PER_SECOND = 32_000
const BASE64_CHUNK_SIZE = 8_192

/** WKWebView (Safari) 支持 audio/mp4，其余环境回退 webm。 */
function pickSupportedMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4'
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm'
  return null
}

function blobToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
      binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_SIZE))
    }
    return btoa(binary)
  })
}

/**
 * 按住说话的录音状态机：
 * start() 按下开始，stop() 松开返回音频，cancel() 丢弃。
 * 录音达到 MAX_DURATION_MS 自动收尾并触发 onAutoStop。
 * 组件卸载 / 窗口失焦时自动丢弃录音并释放麦克风。
 */
export function useVoiceInput(options?: UseVoiceInputOptions) {
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [durationMs, setDurationMs] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef(0)
  const tickRef = useRef<number | null>(null)
  const mimeTypeRef = useRef<string | null>(null)
  const onAutoStopRef = useRef(options?.onAutoStop)
  onAutoStopRef.current = options?.onAutoStop

  const clearTick = useCallback(() => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current)
      tickRef.current = null
    }
  }, [])

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  /** 停止 recorder 并释放资源，不清理 chunks（由调用方决定去留）。 */
  const shutdownRecorder = useCallback(() => {
    clearTick()
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null
      try {
        recorder.stop()
      } catch {
        // recorder 可能已自行停止，忽略
      }
    }
    recorderRef.current = null
    releaseStream()
    setIsRecording(false)
    setDurationMs(0)
  }, [clearTick, releaseStream])

  const takeChunks = useCallback(() => {
    const blobs = chunksRef.current
    chunksRef.current = []
    return blobs
  }, [])

  const cancel = useCallback(() => {
    shutdownRecorder()
    chunksRef.current = []
  }, [shutdownRecorder])

  const finalize = useCallback((blobs: Blob[], mimeType: string, elapsedMs: number): Promise<VoiceRecording | null> => {
    if (blobs.length === 0) return Promise.resolve(null)
    return blobToBase64(new Blob(blobs, { type: mimeType })).then((base64) => ({
      base64,
      mimeType,
      durationMs: elapsedMs,
    }))
  }, [])

  const start = useCallback(async (): Promise<boolean> => {
    if (recorderRef.current) return true
    setError(null)

    const mimeType = pickSupportedMimeType()
    if (!mimeType) {
      setError('当前环境不支持录音')
      return false
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError('未获得麦克风权限，请在系统设置中允许')
      return false
    }

    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND })
    } catch {
      releaseStream()
      setError('当前环境不支持录音')
      return false
    }

    mimeTypeRef.current = mimeType
    streamRef.current = stream
    chunksRef.current = []
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current = [...chunksRef.current, e.data]
    }
    recorder.start(TICK_INTERVAL_MS)

    startedAtRef.current = Date.now()
    setIsRecording(true)
    setDurationMs(0)
    recorderRef.current = recorder
    clearTick()
    tickRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current
      setDurationMs(elapsed)
      if (elapsed >= MAX_DURATION_MS) {
        // 达到时长上限：自动收尾，转写流程与手动松开一致
        shutdownRecorder()
        finalize(takeChunks(), mimeType, elapsed).then((recording) => {
          if (recording) onAutoStopRef.current?.(recording)
        })
      }
    }, TICK_INTERVAL_MS)
    return true
  }, [clearTick, releaseStream, shutdownRecorder, finalize, takeChunks])

  const stop = useCallback((): Promise<VoiceRecording | null> => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') {
      cancel()
      return Promise.resolve(null)
    }

    const elapsedMs = Date.now() - startedAtRef.current
    const mimeType = mimeTypeRef.current ?? recorder.mimeType

    shutdownRecorder()
    const blobs = takeChunks()

    if (elapsedMs < MIN_DURATION_MS) {
      setError('说话时间太短')
      return Promise.resolve(null)
    }
    return finalize(blobs, mimeType, elapsedMs)
  }, [cancel, finalize, shutdownRecorder, takeChunks])

  // 组件卸载时丢弃录音并释放麦克风（卸载后 setState 由 React 18 忽略，无警告）
  useEffect(() => {
    const handleBlur = () => cancel()
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('blur', handleBlur)
      cancel()
    }
  }, [cancel])

  return {
    isRecording,
    isTranscribing,
    setIsTranscribing,
    durationMs,
    error,
    setError,
    start,
    stop,
    cancel,
  }
}
