/**
 * Login 503 from the bundled Agent.
 * - `clock_skew_detected`: the Manager token is valid but the local system clock disagrees with
 *   Manager's clock (the Agent calibrates against Manager's HTTP Date header first, so this means
 *   the skew could not be compensated). `meta.skew_seconds` is token time minus local time.
 * - `manager_unavailable` covers both an unreachable Manager and a Manager-issued token that fails
 *   local RS256 verification (e.g. mismatched public keys). Only the detail tells them apart.
 */
export function loginUnavailableMessage(problemDetail = '', problemCode = '', problemMeta?: unknown): string {
  if (problemCode === 'clock_skew_detected') {
    const skew = (problemMeta as { skew_seconds?: unknown } | undefined)?.skew_seconds
    const minutes = typeof skew === 'number' && Number.isFinite(skew) ? Math.max(1, Math.round(Math.abs(skew) / 60)) : null
    const gap = minutes === null ? '' : `约 ${minutes} 分钟`
    return `本机系统时间与企业服务器相差${gap}，请开启系统自动校时后重试`
  }
  if (/token failed local verification/i.test(problemDetail)) {
    return '登录凭证未通过本机校验，请核对本机 Agent 的公钥配置，或联系管理员'
  }
  return '企业服务暂不可用,请稍后重试(Manager 未就绪)'
}
