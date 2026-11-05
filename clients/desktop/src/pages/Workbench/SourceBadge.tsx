import { FILTER_LABELS, type SourceFilter } from './projects'
import styles from './index.module.css'

export type SourceKey = Exclude<SourceFilter, 'all'>

export default function SourceBadge({ source }: { source: SourceKey }) {
  return <span className={`${styles.sourceBadge} ${styles[`source_${source}`]}`}>{FILTER_LABELS[source]}</span>
}
