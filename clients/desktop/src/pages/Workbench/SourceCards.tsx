/** 顶部来源卡片：按来源统计项目数并切换筛选。只显示扫描出项目的平台（见 shownSources）。 */
import { Cpu, LayoutDashboard, MonitorOff, TriangleAlert } from 'lucide-react'
import { DEEPSEEK, type ProjectSource, type SourceFilter, type SourceState } from './projects'
import SourceBadge, { type SourceKey } from './SourceBadge'
import styles from './index.module.css'

const SOURCE_DESCRIPTIONS: Record<SourceKey, string> = {
  fred: '本机 Agent 会话中 AI 员工工作目录里的项目',
  codex: 'Codex 会话中新建的项目目录（只读识别）',
  claude: 'Claude Code CLI 会话中新建的项目目录（只读识别）',
  claude_desktop: 'Claude 桌面版 Cowork 输出与 Code 会话中新建的项目目录（实验性，只读识别）',
  workbuddy: '~/WorkBuddy 下的任务目录（只读识别）',
  deepseek: '任一来源上由 DeepSeek 模型做出的项目，与各来源重复计数',
}

// 来源卡片较窄，提示只放最短的定位信息，完整说明在 title 中。
const SOURCE_HINTS: Record<SourceKey, string> = {
  fred: 'AI 员工项目',
  codex: '~/.codex',
  claude: '~/.claude',
  claude_desktop: 'Cowork / Code',
  workbuddy: '~/WorkBuddy',
  deepseek: '按模型筛选',
}

function sourceStatusText(state: SourceState | undefined, loading: boolean, hint: string): string {
  if (loading || !state) return '读取中…'
  if (state.status === 'missing') return '本机未发现记录'
  if (state.status === 'desktop_only') return '仅桌面端可读取'
  if (state.status === 'error') return state.message ?? '读取失败'
  if (state.message) return state.message
  return state.truncated ? '仅扫描最近的会话' : hint
}

export default function SourceCards({ source, states, loading, totalProjects, fileCount, employeeCount, countOf, shown, showDeepSeek, onSelect }: {
  source: SourceFilter
  states: Partial<Record<ProjectSource, SourceState>>
  loading: { fred: boolean; local: boolean }
  totalProjects: number
  fileCount: number
  employeeCount: number
  countOf: (key: SourceKey) => number
  shown: readonly ProjectSource[]
  showDeepSeek: boolean
  onSelect: (next: SourceFilter) => void
}) {
  const isLoading = loading.fred || loading.local
  return <section className={styles.sources} aria-label="项目来源">
    <button type="button" className={`${styles.sourceCard} ${source === 'all' ? styles.sourceCardActive : ''}`} aria-pressed={source === 'all'} onClick={() => onSelect('all')}>
      <span className={styles.sourceCardTop}><LayoutDashboard size={16} />全部来源</span>
      <strong>{totalProjects}<small> 个项目</small></strong>
      <span className={styles.sourceCardHint} title={`${fileCount} 个文件 · ${employeeCount} 位员工`}>{isLoading ? '读取中…' : `${fileCount} 个文件`}</span>
    </button>
    {shown.map(key => {
      const state = states[key]
      const sourceLoading = key === 'fred' ? loading.fred : loading.local
      const unavailable = !sourceLoading && state && state.status !== 'ready'
      const status = sourceStatusText(state, sourceLoading, SOURCE_HINTS[key])
      return <button key={key} type="button" className={`${styles.sourceCard} ${source === key ? styles.sourceCardActive : ''}`} aria-pressed={source === key} onClick={() => onSelect(key)}>
        <span className={styles.sourceCardTop}><SourceBadge source={key} />{unavailable && (state.status === 'error' ? <TriangleAlert size={14} className={styles.warnIcon} /> : <MonitorOff size={14} />)}</span>
        <strong>{sourceLoading ? '—' : countOf(key)}<small> 个项目</small></strong>
        <span className={`${styles.sourceCardHint} ${state?.status === 'error' && !sourceLoading ? styles.sourceCardError : ''}`} title={`${status} · ${SOURCE_DESCRIPTIONS[key]}`}>{status}</span>
      </button>
    })}
    {showDeepSeek && <button type="button" className={`${styles.sourceCard} ${source === DEEPSEEK ? styles.sourceCardActive : ''}`} aria-pressed={source === DEEPSEEK} onClick={() => onSelect(DEEPSEEK)}>
      <span className={styles.sourceCardTop}><SourceBadge source={DEEPSEEK} /><Cpu size={14} /></span>
      <strong>{countOf(DEEPSEEK)}<small> 个项目</small></strong>
      <span className={styles.sourceCardHint} title={SOURCE_DESCRIPTIONS.deepseek}>{SOURCE_HINTS.deepseek}</span>
    </button>}
  </section>
}
