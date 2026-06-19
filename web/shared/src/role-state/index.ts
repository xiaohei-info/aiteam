/**
 * role-state（08 §12.2，03 §9.7）。前端角色判定 helper，基于冻结角色枚举。
 *
 * 红线：只用 EnterpriseRole / PlatformRole（禁旧 admin/manager/viewer）。
 * 角色来源于已验签 token 的 claims.roles（前端不自行授权，仅做 UI 门控；
 * 真正鉴权在后端）。
 */

import type { AuthSession } from "../contracts/auth.js";
import { EnterpriseRole, PlatformRole } from "../contracts/enums.js";

export type Role = EnterpriseRole | PlatformRole;

/** 当前会话是否持有任一指定角色。 */
export function hasRole(session: AuthSession | null, ...roles: Role[]): boolean {
  if (!session) return false;
  const owned = new Set(session.claims.roles);
  return roles.some((r) => owned.has(r));
}

/** 是否持有全部指定角色。 */
export function hasAllRoles(session: AuthSession | null, ...roles: Role[]): boolean {
  if (!session) return false;
  const owned = new Set(session.claims.roles);
  return roles.every((r) => owned.has(r));
}

/** 企业侧管理权（owner / enterprise_admin）——UI 门控用。 */
export function isEnterpriseAdmin(session: AuthSession | null): boolean {
  return hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
}

/** 企业侧财务权。 */
export function isFinanceAdmin(session: AuthSession | null): boolean {
  return hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.FINANCE_ADMIN);
}

/** 平台侧系统管理权。 */
export function isSystemAdmin(session: AuthSession | null): boolean {
  return hasRole(session, PlatformRole.SYSTEM_ADMIN);
}

/** 是否已登录（有 principal 且 token 未过期）。 */
export function isAuthenticated(session: AuthSession | null, now: number = Date.now()): boolean {
  if (!session) return false;
  return session.claims.exp * 1000 > now;
}

/** 当前租户 id（Manager 端贯穿鉴权；未登录或无 tenant 返回 null）。 */
export function tenantId(session: AuthSession | null): string | null {
  return session?.claims.tenant_id ?? null;
}
