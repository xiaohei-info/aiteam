export interface BuildInfo {
  version: string
  /** 构建时的 git 短提交号；工作区有未提交改动时带 -dirty 后缀 */
  commit: string
  /** ISO 时间；dev 为开发服务器启动时间 */
  builtAt: string
  dev: boolean
}

export interface BuildInfoRow {
  label: string
  value: string
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatBuiltAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '未知'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function describeBuildInfo(info: BuildInfo): BuildInfoRow[] {
  return [
    { label: '运行方式', value: info.dev ? '开发模式（pnpm tauri dev）' : '安装包' },
    { label: '版本', value: info.version },
    { label: '构建提交', value: info.commit },
    { label: info.dev ? '启动时间' : '构建时间', value: formatBuiltAt(info.builtAt) },
  ]
}
