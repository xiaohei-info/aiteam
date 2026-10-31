import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkRecords } from '../../hooks/useWorkRecords'
import { formatUsdDecimal, WORK_OUTCOME_LABELS } from '../../lib/workRecords'
import { agentApi } from '../../api/agent'
import { useChatStore } from '../../stores/chat'
import type { WorkRecord } from '../../api/agent/observations.types'

interface WorkHistoryProps { employeeId?: string; compact?: boolean }
const timeLabel = (value: string | null) => value ? new Date(value).toLocaleString() : '未知'

export default function WorkHistory({ employeeId, compact = false }: WorkHistoryProps) {
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [navigationError, setNavigationError] = useState('')
  const history = useWorkRecords(employeeId, start ? new Date(start).toISOString() : undefined, end ? new Date(end).toISOString() : undefined)
  const navigate = useNavigate()
  const handleLocate = async (record: WorkRecord) => {
    const entryRef = record.output_entry_ref ?? record.input_entry_ref
    if (!entryRef) return
    try {
      const result = await agentApi.listEntriesPage(record.conversation_id, { entry_ref: entryRef, limit: 1 })
      if (!result.data.entries.some(entry => entry.entry_ref === entryRef)) throw new Error('原消息不可定位')
      const conversation = await agentApi.getConversation(record.conversation_id)
      const store = useChatStore.getState()
      await store.refreshConversations()
      if (conversation.kind === 'group') store.setActiveGroupId(conversation.id)
      else store.setActiveConvId(conversation.id)
      store.setHighlightMsgId(entryRef)
      navigate(conversation.kind === 'group' ? '/group-chat' : '/chat')
    } catch { setNavigationError('原消息不可定位或当前服务不可用') }
  }
  return <section className="p-4 min-w-0" aria-label="本机员工工作历史">
    <div className="flex items-center justify-between gap-3 mb-3">
      <h3 className="text-sm text-txt-primary">本机员工工作历史</h3>
      <button type="button" onClick={history.retry} disabled={history.loading}>刷新</button>
    </div>
    {!compact && <div className="flex gap-3 mb-3">
      <label>开始时间<input aria-label="工作历史开始时间" type="datetime-local" value={start} onChange={event => setStart(event.target.value)} /></label>
      <label>结束时间<input aria-label="工作历史结束时间" type="datetime-local" value={end} onChange={event => setEnd(event.target.value)} /></label>
    </div>}
    {(history.error || navigationError) && <p role="alert">{history.error || navigationError}</p>}
    {history.loading && <p role="status">正在读取工作记录…</p>}
    {!history.loading && !history.error && history.records.length === 0 && <p>所选范围暂无已记录执行</p>}
    <div className="overflow-auto" style={{ maxHeight: compact ? 200 : 440 }}>
      <table className="w-full text-xs text-left"><thead><tr><th>员工 / 任务</th><th>结果</th><th>真实时间 / 来源</th><th>用量 / 费用</th><th>消息</th></tr></thead>
        <tbody>{history.records.map(record => <tr key={record.id} className="border-t border-[var(--border)]">
          <td className="py-3 pr-3">{record.employee_display_name}<p>{record.task_summary ?? '原消息不可定位'}</p><p className="text-txt-muted">{record.result_summary}</p></td>
          <td>{WORK_OUTCOME_LABELS[record.outcome]}</td>
          <td>{record.provenance === 'pi_history' ? `历史条目 ${timeLabel(record.occurred_at)}` : `${timeLabel(record.started_at)} — ${timeLabel(record.ended_at)}`}</td>
          <td>{record.usage?.token_total ?? '未知'} token<br />{formatUsdDecimal(record.usage?.cost_total)}</td>
          <td><button type="button" disabled={!record.input_entry_ref && !record.output_entry_ref} onClick={() => void handleLocate(record)}>{record.input_entry_ref || record.output_entry_ref ? '定位消息' : '原消息不可定位'}</button></td>
        </tr>)}</tbody>
      </table>
    </div>
    {history.hasMore && <button type="button" disabled={history.loading} onClick={() => void history.loadMore()}>加载更早记录</button>}
  </section>
}
