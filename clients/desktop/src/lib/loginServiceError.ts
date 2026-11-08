/**
 * Login 503 from the bundled Agent.
 * - `clock_skew_detected`: the Manager token is valid but the local system clock disagrees with
 *   Manager's clock (the Agent calibrates against Manager's HTTP Date header first, so this means
 *   the skew could not be compensated). `meta.skew_seconds` is token time minus local time.
 * - `manager_unavailable` covers both an unreachable Manager and a Manager-issued token that fails
 *   local RS256 verification (e.g. mismatched public keys). Only the detail tells them apart.
 */
export type ClockFixPlatform = 'windows' | 'macos' | 'other'

/** WebView2 reports "Windows NT", WKWebView "Macintosh"; anything else gets the generic hint. */
export function clockFixPlatform(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): ClockFixPlatform {
  if (/Windows NT/i.test(userAgent)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos'
  return 'other'
}

// Unsynchronised clocks are most common on Windows, so spell out where the switch lives.
const CLOCK_FIX: Record<ClockFixPlatform, string> = {
  windows: '请打开「设置 > 时间和语言 > 日期和时间」，开启「自动设置时间」并点击「立即同步」后重试',
  macos: '请打开「系统设置 > 通用 > 日期与时间」，开启「自动设置时间和日期」后重试',
  other: '请开启系统自动校时后重试',
}

export function loginUnavailableMessage(problemDetail = '', problemCode = '', problemMeta?: unknown, platform: ClockFixPlatform = clockFixPlatform()): string {
  if (problemCode === 'clock_skew_detected') {
    const skew = (problemMeta as { skew_seconds?: unknown } | undefined)?.skew_seconds
    const minutes = typeof skew === 'number' && Number.isFinite(skew) ? Math.max(1, Math.round(Math.abs(skew) / 60)) : null
    const gap = minutes === null ? '本机系统时间与企业服务器的偏差无法确定' : `本机系统时间与企业服务器相差约 ${minutes} 分钟`
    return `${gap}，${CLOCK_FIX[platform]}`
  }
  if (/token failed local verification/i.test(problemDetail)) {
    return '登录凭证未通过本机校验，请核对本机 Agent 的公钥配置，或联系管理员'
  }
  return '企业服务暂不可用,请稍后重试(Manager 未就绪)'
}
