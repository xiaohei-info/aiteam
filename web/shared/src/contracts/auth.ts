/**
 * 认证身份契约镜像（03 §9.3/§9.5，D8/D23）。来源 `server/shared/contracts/auth.py`。
 *
 * 仅镜像前端可见的非敏感投影：UserPrincipal（当前登录主体）与 TokenClaims（解出的 claims）。
 * AuthIdentity.secret 等敏感字段不进入前端镜像。
 */

import type { AuthProvider } from "./enums.js";

/** JWT 载荷（03 §9.5）。前端只读，验签由后端/shared/auth 完成。 */
export interface TokenClaims {
  tenant_id?: string | null;
  enterprise_id?: string | null;
  user_id: string;
  roles: string[];
  exp: number;
}

/** 规范账号 user（principal）。前端展示与 role-state 的输入。 */
export interface UserPrincipal {
  id: string;
  tenant_id?: string | null;
  enterprise_id?: string | null;
  display_name: string;
  status: string;
  roles: string[];
}

/** 前端登录态视图：当前主体 + 解出的 claims（不含密文）。 */
export interface AuthSession {
  principal: UserPrincipal;
  claims: TokenClaims;
  provider?: AuthProvider;
}
