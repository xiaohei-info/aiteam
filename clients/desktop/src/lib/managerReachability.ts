/**
 * 企业服务（Manager）是否连得上。
 *
 * 本机 Agent 对需要登录的接口逐个向 Manager 核对会话：
 * - Manager 明确判定会话已吊销 → 401，桌面端确认后立即退出登录；
 * - Manager 连不上、没能给出结论 → 503 `manager_unavailable`，拒绝访问但登录仍然有效。
 * 这里只记录后一种状态，用于全局提示；任何带登录凭据的请求成功即视为已恢复。
 */
import { create } from 'zustand'

export const MANAGER_UNAVAILABLE_NOTICE = '抱歉，企业服务暂时连不上，请稍后再试。'
const RESTORE_UNAVAILABLE = '抱歉，企业服务暂时连不上，请稍后重试恢复登录。'
const RESTORE_FAILED = '无法验证已保存身份，请确认本机 Agent 和企业服务可用后重试。'

interface ManagerReachabilityState {
  unavailable: boolean
}

export const useManagerReachability = create<ManagerReachabilityState>(() => ({ unavailable: false }))

export function isManagerUnavailable(status: number | undefined, code: string | undefined): boolean {
  return status === 503 && code === 'manager_unavailable'
}

/** 本机 Agent 每次响应后调用；只有带登录凭据的成功响应才能证明 Manager 已恢复。 */
export function reportManagerResponse(status: number, code: string | undefined, authenticated: boolean): void {
  const unavailable = useManagerReachability.getState().unavailable
  if (isManagerUnavailable(status, code)) {
    if (!unavailable) useManagerReachability.setState({ unavailable: true })
  } else if (unavailable && authenticated && status >= 200 && status < 300) {
    useManagerReachability.setState({ unavailable: false })
  }
}

/** 启动时恢复登录失败的提示；Manager 连不上时保留已保存的登录，提示稍后重试。 */
export function restoreFailureMessage(error: unknown): string {
  const { status, code } = (error ?? {}) as { status?: number; code?: string }
  return isManagerUnavailable(status, code) ? RESTORE_UNAVAILABLE : RESTORE_FAILED
}
