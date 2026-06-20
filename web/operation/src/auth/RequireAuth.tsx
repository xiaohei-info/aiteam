/**
 * 路由登录门控：未登录（无 session 或 token 过期）跳 /login。
 * 基于 @aiteam/shared 的 isAuthenticated（claims.exp 校验），真正鉴权在后端。
 */
import { type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { isAuthenticated } from "@aiteam/shared";
import { useSession } from "./session";

export function RequireAuth({ children }: { children: ReactNode }): ReactNode {
  const { session } = useSession();
  const location = useLocation();
  if (!isAuthenticated(session)) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
