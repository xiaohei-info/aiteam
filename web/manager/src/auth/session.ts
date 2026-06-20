/**
 * 会话上下文：当前 AuthSession + token + 登录/登出 + 401 回调。
 *
 * 红线：只持本会话 token 与解出的 claims（03 §9.5），不持密钥/不验签。
 * onUnauthorized 由 api-client 基类在 401 时触发，上层路由据此跳登录。
 */
import { createContext, useContext } from "react";
import type { AuthSession, Problem } from "@aiteam/shared";

export interface SessionContextValue {
  session: AuthSession | null;
  token: string | null;
  signIn: (token: string) => void;
  signOut: () => void;
  onUnauthorized: (problem: Problem | undefined) => void;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession 必须在 <SessionContext.Provider> 内使用");
  }
  return ctx;
}
