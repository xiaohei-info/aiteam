/**
 * Login 503 from the bundled Agent. `manager_unavailable` covers both an unreachable Manager and
 * (since the 6f8ec811 Agent package) a Manager-issued token that fails local RS256 verification,
 * e.g. mismatched public keys or a skewed system clock. Only the detail tells them apart.
 */
export function loginUnavailableMessage(problemDetail = ''): string {
  if (/token failed local verification/i.test(problemDetail)) {
    return '登录凭证未通过本机校验，请核对本机 Agent 的公钥配置和系统时间，或联系管理员'
  }
  return '企业服务暂不可用,请稍后重试(Manager 未就绪)'
}
