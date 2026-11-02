/**
 * 「解决了吗」气泡的「不再提示」偏好。只存在这台设备上，设置页可以重新打开；
 * 关掉提示不影响评估，分隔线上仍可在 7 天内补评。
 */
export const OUTCOME_BUBBLE_STORAGE_KEY = 'aiteam.desktop.outcomeBubble'

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function defaultStorage(): PreferenceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** 读不到存储时按未关闭处理，继续提示。 */
export function isOutcomeBubbleMuted(storage: PreferenceStorage | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(OUTCOME_BUBBLE_STORAGE_KEY) === 'muted'
  } catch {
    return false
  }
}

/** 返回是否保存成功；失败时调用方只在本次界面里生效。 */
export function setOutcomeBubbleMuted(muted: boolean, storage: PreferenceStorage | null = defaultStorage()): boolean {
  if (!storage) return false
  try {
    if (muted) storage.setItem(OUTCOME_BUBBLE_STORAGE_KEY, 'muted')
    else storage.removeItem(OUTCOME_BUBBLE_STORAGE_KEY)
    return true
  } catch {
    return false
  }
}
