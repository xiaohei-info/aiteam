import { useEffect, useState } from 'react'
import { applicationLogSnapshot, recordApplicationLog } from '../../lib/applicationLog'
import { exportApplicationLogs, loadApplicationLogs, logPersistenceStatus, type LogBundle } from '../../lib/desktopLogging'
import { isTauri, resolveAgentBaseUrl } from '../../api/agent/runtime'
import './ApplicationLogs.css'

export default function ApplicationLogs() {
  const [bundle, setBundle] = useState<LogBundle>(() => applicationLogSnapshot())
  const [level, setLevel] = useState('all')
  const [service, setService] = useState('all')
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [agent, setAgent] = useState('尚未读取')
  const refresh = async () => {
    setBusy(true)
    try { setBundle(await loadApplicationLogs()); setMessage('日志已刷新。') }
    catch { setBundle(applicationLogSnapshot()); setMessage('本机日志文件暂不可读，当前仅显示本次页面内存日志。请更新桌面宿主或检查磁盘权限。') }
    finally { setBusy(false) }
  }
  useEffect(() => {
    let disposed = false
    void loadApplicationLogs().then(value => { if (!disposed) setBundle(value) }).catch(() => { if (!disposed) setMessage('日志文件不可读，当前显示内存日志。') })
    void resolveAgentBaseUrl().then(value => {
      if (!disposed) setAgent(value || '浏览器同源代理（真实上游由部署配置决定）')
    }).catch(() => { if (!disposed) setAgent('地址发现失败，查看日志中的实际请求目标') })
    return () => { disposed = true }
  }, [])
  const save = async () => {
    if (!window.confirm('将导出本机应用日志。包含时间、服务地址、请求/工作关联 ID，不包含聊天正文或凭据。远程服务器日志不在其中。请仅通过受信任渠道分享，是否继续？')) return
    setBusy(true)
    try {
      recordApplicationLog('info', 'diagnostics.export_requested')
      const saved = await exportApplicationLogs()
      setMessage(saved ? '已导出本机日志。未上传任何数据；远程服务日志须由管理员另行获取。' : '已取消导出。')
    } catch { setMessage('导出失败，请检查磁盘权限，并选择一个尚不存在的文件名。') }
    finally { setBusy(false) }
  }
  const services = [...new Set(bundle.records.map(record => record.service))]
  const filtered = bundle.records.filter(record => (level === 'all' || record.level === level) && (service === 'all' || record.service === service)
    && JSON.stringify(record).toLowerCase().includes(query.toLowerCase())).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  const targets = [...new Set(bundle.records.flatMap(record => typeof record.fields?.origin === 'string' ? [`${record.fields.dependency ?? record.service}: ${record.fields.origin}`] : []))]
  const persistence = logPersistenceStatus()
  return <section className="settings-card glass-panel application-logs" aria-labelledby="settings-logs-title">
    <h2 id="settings-logs-title" className="settings-card-title">应用日志与诊断</h2>
    <p>覆盖请求、事件流连接、界面异常、认证和本机 Agent 生命周期。默认仅记录技术元数据，不记录输入输出正文、工具参数或凭据。</p>
    <dl>
      <dt>客户端</dt><dd>{bundle.client_version ?? '0.1.0'} · {bundle.platform ?? (isTauri() ? '桌面端' : '浏览器')}</dd>
      <dt>宿主发现的 Agent 地址</dt><dd>{agent}</dd>
      <dt>日志观察到的实际请求目标</dt><dd>{targets.length ? targets.join('；') : '本次记录中暂无请求目标；不代表连接正常。'}</dd>
      <dt>存储范围</dt><dd>{persistence.mode === 'local-files' ? '本机滚动日志；单文件 2 MiB，保留 3 份轮转。Agent 独立记录在其数据目录。' : '浏览器仅保留当前页面最近 1000 条内存日志，刷新后不保留。'}</dd>
      <dt>日志完整性</dt><dd>{bundle.truncated ? '导出读取达到上限，部分记录未包含。' : '已读取当前可用的有界日志。'} 忽略行数：{bundle.omitted_lines ?? 0}；前端队列丢弃：{persistence.dropped}。{persistence.failed ? '最近落盘失败。' : ''}</dd>
    </dl>
    <p>本机导出不包含远程 Agent、Manager、Operation 服务器日志。排查时可用 request_id / trace_id 交由管理员在对应服务中关联查询。旧版本没有生成的日志无法补造。</p>
    <div className="application-log-actions">
      <button type="button" disabled={busy} onClick={() => void refresh()}>刷新日志</button>
      <button type="button" disabled={busy} onClick={() => void save()}>导出本机日志</button>
      <label>级别 <select value={level} onChange={event => setLevel(event.target.value)}><option value="all">全部</option>{['debug', 'info', 'warn', 'error'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>来源 <select value={service} onChange={event => setService(event.target.value)}><option value="all">全部</option>{services.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>筛选 <input value={query} onChange={event => setQuery(event.target.value)} placeholder="事件名或关联 ID" /></label>
    </div>
    <p role="status">{message} 匹配 {filtered.length} 条，显示最近 200 条。</p>
    <pre className="application-log-view" tabIndex={0} aria-label="应用日志">{filtered.slice(0, 200).map(record => JSON.stringify(record)).join('\n') || '暂无日志。'}</pre>
  </section>
}
