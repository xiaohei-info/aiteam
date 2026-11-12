/**
 * 窗口控件按平台分流：Windows 用 Windows 风格的关闭/最大化/最小化（右上角 ─ ▢ ✕），
 * macOS 保持应用内自绘的无边框外观（红黄绿，见 BackendStartupScreen）。
 * 窗口本身始终是无边框透明窗口（tauri.conf.json decorations=false），控件全部自绘。
 */
export function usesWindowsWindowControls(userAgent: string): boolean {
  return /Windows/i.test(userAgent)
}
