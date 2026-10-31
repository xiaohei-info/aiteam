import { useCallback, useEffect, useRef, useState } from 'react'
import { agentApi } from '../api/agent'
import type { WorkRecord } from '../api/agent/observations.types'
import { matchesWorkWindow, mergeWorkChanges } from '../lib/workRecords'
import { useAgentAuthStore } from '../stores/agentAuth'

export function useWorkRecords(employeeId?: string, windowStart?: string, windowEnd?: string) {
  const identity = useAgentAuthStore(state => state.token)
  const [records, setRecords] = useState<WorkRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const loadRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    const controller = new AbortController()
    const window = { window_start: windowStart, window_end: windowEnd }
    let values = new Map<string, WorkRecord>()
    const changed = new Set<string>() // An older history page cannot resurrect a tombstone or overwrite a newer upsert.
    let before: string | undefined
    let after: string | undefined
    let busy = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setRecords([]); setLoading(true); setError(null); setHasMore(false)
    const publish = () => {
      if (controller.signal.aborted) return
      setRecords([...values.values()].sort((a, b) => (b.occurred_at ? Date.parse(b.occurred_at) : -1) - (a.occurred_at ? Date.parse(a.occurred_at) : -1) || a.id.localeCompare(b.id)))
    }
    const poll = async () => {
      if (!after || controller.signal.aborted) return
      try {
        let more = true
        while (more && !controller.signal.aborted) {
          const response = await agentApi.getWorkChanges({ employee_id: employeeId, after, limit: 100 }, controller.signal)
          if (controller.signal.aborted) return
          for (const change of response.data) changed.add(change.record_id)
          values = mergeWorkChanges(values, response.data, window)
          if (response.page.has_more && response.page.next_cursor === after) throw new Error('工作变化游标未前进')
          after = response.page.next_cursor // Retain even an empty response's watermark.
          more = response.page.has_more
          publish()
        }
        setError(null)
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '工作记录同步失败')
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 5000)
      }
    }
    const load = async () => {
      if (busy || controller.signal.aborted) return
      busy = true; setLoading(true)
      try {
        const response = await agentApi.getWorkRecords({ ...window, employee_id: employeeId, before, limit: 50 }, controller.signal)
        if (controller.signal.aborted) return
        const initial = after === undefined
        for (const record of response.data) if (!changed.has(record.id) && matchesWorkWindow(record, window)) values.set(record.id, record)
        if (response.page.has_more && (!response.page.next_cursor || response.page.next_cursor === before)) throw new Error('工作历史游标无效')
        before = response.page.next_cursor ?? undefined
        if (initial) after = response.meta.after
        setHasMore(response.page.has_more); setError(null); publish()
        if (initial) void poll()
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '工作历史读取失败')
      } finally {
        busy = false
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    loadRef.current = load
    void load()
    return () => { controller.abort(); clearTimeout(timer); loadRef.current = async () => {} }
  }, [identity, employeeId, windowStart, windowEnd, attempt])
  const loadMore = useCallback(() => loadRef.current(), [])
  const retry = useCallback(() => setAttempt(value => value + 1), [])
  return { records, loading, error, hasMore, loadMore, retry }
}
