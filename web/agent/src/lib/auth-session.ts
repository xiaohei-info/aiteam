/**
 * 本端会话态：由缓存的 token + claims 构造前端可见的 AuthSession（03 §9.5/§9.7）。
 *
 * scaffold 取舍：/api/agent/whoami 仅回 TokenClaims；UserPrincipal 的展示字段
 * 暂由 claims 派生（display_name 用 user_id 兜底），后续 /api/agent/me 定型后再替换。
 * 真正鉴权在后端；前端只做 UI 门控（role-state）。
 */

import type { AuthSession, TokenClaims, UserPrincipal } from "@aiteam/shared/contracts";

export function sessionFromClaims(claims: TokenClaims): AuthSession {
  const principal: UserPrincipal = {
    id: claims.user_id,
    tenant_id: claims.tenant_id ?? null,
    enterprise_id: claims.enterprise_id ?? null,
    display_name: claims.user_id,
    status: "active",
    roles: claims.roles,
  };
  return { principal, claims };
}
