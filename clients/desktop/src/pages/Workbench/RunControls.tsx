/** 一个可运行单元的运行条：运行 / 打开 / 停止、状态、缺少运行环境的提示和日志。 */
import { ExternalLink, FolderSearch, LoaderCircle, Play, Square, Terminal, TriangleAlert } from 'lucide-react'
import { RUNNER_LABELS, runnerDetail, runPhaseText, type RunStatus, type RunUnit } from './projects'
import styles from './index.module.css'

export default function RunControls({ label, removed, runner, needsPython, status, pending, busy, error, onRun, onStop, onReveal, onTryOpen, onDownloadPython }: {
  /** 群聊员工名和 / 或子文件夹名；单个目录本身为 null。 */
  label: string | null
  removed: boolean
  runner: RunUnit['runner'] | undefined
  needsPython: boolean
  status: RunStatus | undefined
  pending: boolean
  busy: boolean
  error: string
  onRun: () => void
  onStop: () => void
  onReveal: () => void
  onTryOpen: () => void
  onDownloadPython: () => void
}) {
  const running = Boolean(status?.running)
  const phase = runPhaseText(status)
  const failed = status?.phase === 'failed' || status?.url_timed_out
  const logs = status?.logs ?? []
  return <div className={styles.runRow}>
    <div className={styles.runHead}>
      <div className={styles.runInfo}>
        {label && <strong className={removed ? styles.removedLabel : undefined}>{label}{removed ? '（已移出）' : ''}</strong>}
        {runner
          ? <span className={styles.runDetail}><span className={`${styles.runnerBadge} ${runner.kind === 'none' ? styles.runnerBadgeMuted : ''}`}>{RUNNER_LABELS[runner.kind]}</span>{runnerDetail(runner)}</span>
          : <span className={styles.runDetail}><LoaderCircle size={12} className={styles.spinner} />正在识别运行方式…</span>}
      </div>
      <div className={styles.runActions}>
        {runner && runner.kind !== 'none' && !running && <button type="button" className={styles.primaryButton} disabled={busy || needsPython} title={needsPython ? '需要先安装 Python 3' : undefined} onClick={onRun}>
          {pending ? <LoaderCircle size={14} className={styles.spinner} /> : <Play size={14} />}运行
        </button>}
        {running && <button type="button" className={styles.primaryButton} disabled={busy || !status?.url} onClick={onRun} title={status?.url ?? '等待项目输出访问地址'}>
          {pending ? <LoaderCircle size={14} className={styles.spinner} /> : <ExternalLink size={14} />}打开
        </button>}
        {running && !status?.url && status?.url_timed_out && status.port && <button type="button" className={styles.smallButton} onClick={onTryOpen}><ExternalLink size={13} />尝试在浏览器打开</button>}
        {running && <button type="button" className={styles.smallButton} disabled={busy} onClick={onStop}><Square size={12} />停止</button>}
        <button type="button" className={styles.smallButton} onClick={onReveal}><FolderSearch size={13} />在文件夹中显示</button>
      </div>
    </div>
    {(phase || status?.url) && <div className={`${styles.runStatus} ${failed ? styles.runStatusError : ''}`} role="status">
      {running && status?.phase === 'running' && <span className={styles.runningDot} aria-hidden="true" />}
      {phase && <span>{phase}</span>}
      {running && status?.url && <code>{status.url}</code>}
    </div>}
    {needsPython && !running && <div className={styles.errorBanner} role="status">
      <TriangleAlert size={15} /><span>需要先安装 Python 3，装好后点右上角「刷新」</span>
      <button type="button" className={styles.smallButton} onClick={onDownloadPython}><ExternalLink size={13} />下载 Python</button>
    </div>}
    {error && <div className={styles.errorBanner} role="alert"><TriangleAlert size={15} /><span>{error}</span></div>}
    {logs.length > 0 && <details className={styles.logs} open={Boolean(failed)}>
      <summary><Terminal size={13} />日志（最近 {logs.length} 行）</summary>
      <pre>{logs.join('\n')}</pre>
    </details>}
  </div>
}
