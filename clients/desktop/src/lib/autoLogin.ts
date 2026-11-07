// 自动登录：只在每次启动、恢复已保存登录失败后进入登录页的那一次，用钥匙串里记住的密码登录。
// 只有用户主动退出会结束本次启动的自动登录机会；过期、被吊销或 401 掉签仍可按开关自动恢复。
// 本地只保存开关本身；账号密码仍只在钥匙串。

export const AUTO_LOGIN_STORAGE_KEY = 'aiteam.login.auto'

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function defaultStorage(): PreferenceStorage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export function readAutoLoginPreference(storage: PreferenceStorage | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(AUTO_LOGIN_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeAutoLoginPreference(enabled: boolean, storage: PreferenceStorage | null = defaultStorage()): void {
  try {
    if (enabled) storage?.setItem(AUTO_LOGIN_STORAGE_KEY, 'true')
    else storage?.removeItem(AUTO_LOGIN_STORAGE_KEY)
  } catch {
    // The preference is a convenience; failing to store it only means manual login next time.
  }
}

let launchAttemptAvailable = true

/** 本次启动中已退出登录：之后再到登录页都不自动登录。 */
export function endLaunchAutoLogin(): void {
  launchAttemptAvailable = false
}

/** 取走本次启动唯一的一次自动登录机会。 */
export function takeLaunchAutoLogin(): boolean {
  const available = launchAttemptAvailable
  launchAttemptAvailable = false
  return available
}

export interface AutoLoginInput {
  enabled: boolean
  hasSavedCredentials: boolean
  passwordResetPending: boolean
}

export function shouldAutoLogin({ enabled, hasSavedCredentials, passwordResetPending }: AutoLoginInput): boolean {
  if (!enabled || !hasSavedCredentials || passwordResetPending) return false
  return takeLaunchAutoLogin()
}

/** Test-only: a new launch. */
export function resetLaunchAutoLoginForTest(): void {
  launchAttemptAvailable = true
}
