/** 代码项目首次运行前的确认：展示将执行的命令、npm 脚本实际内容、工作目录和下载源。 */
import { Play, ShieldAlert, TriangleAlert } from 'lucide-react'
import { ChatDialog } from '../../components/Chat/ChatDialog'
import { consentScriptLine, dependencySourceLabel, type DependencySource } from './projects'
import type { ConsentRequest } from './useProjectRuns'
import styles from './index.module.css'

export default function ConsentDialog({ request, downloadSource, onCancel, onConfirm }: {
  request: ConsentRequest
  downloadSource: DependencySource
  onCancel: () => void
  onConfirm: () => void
}) {
  const lines = [...request.commands, consentScriptLine(request.unit.runner, request.script)].filter(Boolean)
  return <ChatDialog title="确认运行项目" icon={<ShieldAlert size={18} />} description={request.unit.dir ? `${request.projectName} / ${request.unit.dir}` : request.projectName} onClose={onCancel}>
    <p className="chat-tools-note">首次运行（或命令、依赖文件变化后）需要你确认。将在项目目录中依次执行：</p>
    <pre className={styles.consentCommands}>{lines.join('\n')}</pre>
    <p className={styles.consentCwd}><span>工作目录</span>{request.cwd}</p>
    <p className={styles.consentCwd}><span>依赖下载源</span>{dependencySourceLabel(downloadSource)}（可在工作台右上角「下载源」中更改）</p>
    <p className={styles.consentWarning}><TriangleAlert size={15} /><span>项目代码会以你的用户权限运行，可能访问网络和本机文件；安装依赖时会联网下载，并可能执行依赖包的安装脚本。只运行你信任的项目。</span></p>
    <footer>
      <button type="button" onClick={onCancel}>取消</button>
      <button type="button" className={styles.consentConfirm} onClick={onConfirm}><Play size={14} />确认并运行</button>
    </footer>
  </ChatDialog>
}
