/**
 * 路由守卫（08 §12.2）。未登录重定向到 /login，已登录访问 /login 重定向到 /workspace。
 * 基于 shared role-state 的 isAuthenticated（token 未过期判定）。
 */

import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { isAuthenticated } from "@aiteam/shared/role-state";

import { useApp } from "../lib/app-context";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session } = useApp();
  const location = useLocation();
  if (!isAuthenticated(session)) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
