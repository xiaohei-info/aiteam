/**
 * macOS 样式的红黄绿窗口控件（无边框窗口自绘）。
 * Windows 由 WindowsWindowControls 在右上角自绘 ─ ▢ ✕，这里返回 null，避免出现两套控件。
 */
import { getCurrentWindow } from '@tauri-apps/api/window'
import { usesWindowsWindowControls } from '../../lib/windowChrome'

const DOT_BASE =
  'h-[12px] w-[12px] flex-shrink-0 cursor-pointer rounded-full border shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition-colors duration-150'

export default function MacWindowControls({ className }: { className?: string }) {
  if (usesWindowsWindowControls(typeof navigator === 'undefined' ? '' : navigator.userAgent)) return null
  return (
    <div className={className ? `flex items-center gap-[7px] ${className}` : 'flex items-center gap-[7px]'}>
      <button
        type="button"
        onClick={() => void getCurrentWindow().close()}
        className={`${DOT_BASE} border-[#e0443e]/40 bg-[#ff5f57] hover:bg-[#ff3b30]`}
        title="关闭"
        aria-label="关闭窗口"
      />
      <button
        type="button"
        onClick={() => void getCurrentWindow().minimize()}
        className={`${DOT_BASE} border-[#dea123]/40 bg-[#febc2e] hover:bg-[#f5a623]`}
        title="最小化"
        aria-label="最小化窗口"
      />
      <button
        type="button"
        onClick={() => void getCurrentWindow().toggleMaximize()}
        className={`${DOT_BASE} border-[#1aab29]/40 bg-[#28c840] hover:bg-[#1db934]`}
        title="最大化 / 还原"
        aria-label="切换窗口最大化"
      />
    </div>
  )
}
