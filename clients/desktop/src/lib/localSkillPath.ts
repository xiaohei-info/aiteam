/**
 * 桌面端文件选择可能给 `file:///Users/…`（Tauri `FilePath::Url` 序列化成字符串），
 * 而本机 Agent 按绝对路径读目录。这里统一还原成路径，已还原过的保持不变。
 * 与 Agent 端 `custom-skills.ts` 的 `toLocalPath` 同口径。
 */
export function toLocalPath(value: string): string {
  const trimmed = value.trim()
  if (!/^file:\/\//i.test(trimmed)) return trimmed
  const decoded = decodeURIComponent(trimmed.slice('file://'.length).replace(/^localhost(?=\/)/i, ''))
  // Windows：file:///C:/Users/x → C:/Users/x
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded
}
