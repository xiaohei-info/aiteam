/**
 * 离线状态全屏遮罩，检测到无网络连接时覆盖整个界面，提示用户检查网络设置。
 *
 * @注意 fixed 定位，z-index=50，会遮挡所有页面内容；由 useNetwork hook 控制渲染。
 */
import { useDialogFocus } from '../hooks/useDialogFocus'

export default function OfflineOverlay() {
  const dialogRef = useDialogFocus<HTMLDivElement>()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0/90 backdrop-blur-md">
      <div ref={dialogRef} className="animate-fade-up rounded-3xl border border-[var(--border)] bg-surface-1 px-10 py-8 text-center shadow-2xl" role="alertdialog" aria-modal="true" aria-labelledby="offline-title" aria-describedby="offline-description" tabIndex={-1}>
        <div className="mb-4 text-4xl" aria-hidden="true">📡</div>
        <h2 id="offline-title" className="font-display text-base font-semibold text-txt-primary">无网络连接</h2>
        <p id="offline-description" className="mt-1 text-xs text-txt-secondary">请检查网络设置后重试</p>
        <div className="mt-4 h-0.5 w-16 mx-auto rounded bg-brand/20 overflow-hidden">
          <div className="h-full w-1/3 rounded bg-brand animate-[slide-in_1.5s_ease-in-out_infinite]" />
        </div>
      </div>
    </div>
  )
}
