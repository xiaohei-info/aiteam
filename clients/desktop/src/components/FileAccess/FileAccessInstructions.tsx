import { useEffect, useState } from 'react'
import { ChevronDown, ExternalLink, HelpCircle } from 'lucide-react'

interface Props {
  platform: string
  expanded?: boolean
  busy?: boolean
  onOpenSettings?: () => void
}

export default function FileAccessInstructions({ platform, expanded = false, busy = false, onOpenSettings }: Props) {
  const [isOpen, setIsOpen] = useState(expanded)
  useEffect(() => { setIsOpen(expanded) }, [expanded])
  return <details className="file-access-help" open={isOpen} onToggle={event => setIsOpen(event.currentTarget.open)}>
    <summary tabIndex={0}>
      <HelpCircle size={14} strokeWidth={1.7} aria-hidden="true" />
      <span>如何授权与管理系统权限</span>
      <ChevronDown className="file-access-help-chevron" size={14} aria-hidden="true" />
    </summary>
    {isOpen && <div className="file-access-instructions">
      {platform === 'macos' ? <>
        <ol>
          <li><strong>选择访问范围</strong><p>在系统选择器中按 <kbd>⌘⇧G</kbd>，输入 <code>/</code> 并选择，可授权磁盘根目录；也可以只选择需要使用的文件夹。</p></li>
          <li><strong>检查系统权限</strong><p>桌面、文稿或外置磁盘仍无法读取时，前往“系统设置 → 隐私与安全性 → 文件与文件夹”，检查 AIFred 对应权限。此列表由系统生成，无法手动添加应用。</p></li>
          <li><strong>列表中没有 AIFred？</strong><p>进入“完全磁盘访问权限”，点击列表下方的“＋”，选择正在使用的 <code>AIFred.app</code>（通常位于“应用程序”），按系统提示验证身份并开启开关，然后完全退出并重新打开 AIFred。若应用仍在安装镜像中，请先将它拖入“应用程序”。</p></li>
        </ol>
        <p className="file-access-help-note">取消应用内授权不会改变 macOS 的隐私开关；如需一并撤销，请在系统设置中关闭对应权限。</p>
      </> : platform === 'windows' ? <>
        <ol>
          <li><strong>选择磁盘或文件夹</strong><p>Windows 每个磁盘分别授权。在系统选择器的“此电脑”中选择 <code>C:\</code>、<code>D:\</code> 等根目录（可多选），或只选择需要的文件夹。</p></li>
          <li><strong>检查系统权限</strong><p>仍被拒绝时，检查“设置 → 隐私和安全性 → 文件系统”（Windows 10 为“隐私 → 文件系统”）中的适用开关，以及文件夹“属性 → 安全”中当前用户的读取权限。网络共享还需要对应账号的访问权限。</p></li>
        </ol>
        <p className="file-access-help-note">应用内授权不会修改系统权限。取消系统权限需在 Windows 设置或文件夹属性中操作。</p>
      </> : <p>请选择要访问的目录。若系统仍拒绝读取，请在文件管理器中检查当前用户的目录读取权限。</p>}
      <p className="file-access-help-note">通过文件选择器单独选中的文件仍可单独授权；取消目录授权不会删除已导入的副本。</p>
      {onOpenSettings && (platform === 'macos' || platform === 'windows') && <button type="button" className="file-access-link" disabled={busy} onClick={onOpenSettings}>
        打开系统权限设置<ExternalLink size={12} aria-hidden="true" />
      </button>}
    </div>}
  </details>
}
