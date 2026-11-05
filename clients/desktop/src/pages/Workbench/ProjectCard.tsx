/** 项目列表中的一张卡片。 */
import { ChevronRight, Cpu, FolderOpen } from 'lucide-react'
import FileIcon from './FileIcon'
import { formatTime } from './format'
import { RUNNER_LABELS, type ProjectFile, type ProjectSummary, type RunnerKind } from './projects'
import SourceBadge from './SourceBadge'
import styles from './index.module.css'

const CARD_FILE_CHIPS = 3

/** 卡片上展示的文件：最近修改的在前。 */
function recentFiles(project: ProjectSummary, count: number): ProjectFile[] {
  return project.parts
    .flatMap(part => part.files)
    .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
    .slice(0, count)
}

function EmployeeAvatar({ project }: { project: ProjectSummary }) {
  if (project.employeeAvatarUrl) return <img className={styles.avatar} src={project.employeeAvatarUrl} alt="" />
  return <span className={`${styles.avatar} ${styles[`source_${project.source}`]}`} aria-hidden="true">{project.employeeName.slice(0, 1).toUpperCase()}</span>
}

export default function ProjectCard({ project, selected, runnerKind, apps, running, onSelect }: {
  project: ProjectSummary
  selected: boolean
  /** 桌面端识别出的运行方式；浏览器开发模式为 null。 */
  runnerKind: RunnerKind | null
  /** 能单独运行的应用数。 */
  apps: number
  running: boolean
  onSelect: () => void
}) {
  const chips = recentFiles(project, CARD_FILE_CHIPS)
  return <button type="button" className={`${styles.card} ${selected ? styles.cardSelected : ''}`} aria-pressed={selected} onClick={onSelect}>
    <span className={styles.cardTop}>
      <EmployeeAvatar project={project} />
      <span className={styles.cardEmployee}>{project.employeeName}</span>
      <SourceBadge source={project.source} />
      <ChevronRight size={16} />
    </span>
    <strong>{project.name}</strong>
    {project.description && <span className={styles.cardPreview}>{project.description}</span>}
    <span className={styles.cardFiles}>
      {chips.map(file => <span key={file.id} className={styles.fileChip} title={file.path}><FileIcon file={file} size={12} />{file.name}</span>)}
      {project.fileCount > chips.length && <span className={styles.fileChipMore}>+{project.fileCount - chips.length}</span>}
    </span>
    <span className={styles.cardMeta}>
      {running && <span className={styles.runningTag}><span className={styles.runningDot} aria-hidden="true" />运行中</span>}
      {runnerKind && <span className={`${styles.runnerBadge} ${runnerKind === 'none' ? styles.runnerBadgeMuted : ''}`}>{RUNNER_LABELS[runnerKind]}</span>}
      {apps > 1 && <span>{apps} 个应用</span>}
      <span>{formatTime(project.updatedAt)}</span>
      <span>{project.fileCount} 个文件</span>
      {project.isGroup && <span>群聊</span>}
      {project.models.length > 0 && <span className={styles.cardTag} title={project.models.join('、')}><Cpu size={12} />{project.models.join('、')}</span>}
      {project.location && <span className={styles.cardTag} title={project.location}><FolderOpen size={12} />{project.location}</span>}
    </span>
  </button>
}
