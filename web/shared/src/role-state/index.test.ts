import { describe, it, expect } from "vitest";
import {
  hasRole,
  hasAllRoles,
  isEnterpriseAdmin,
  isFinanceAdmin,
  isSystemAdmin,
  isAuthenticated,
  tenantId,
} from "./index.js";
import { EnterpriseRole, PlatformRole } from "../contracts/enums.js";
import type { AuthSession } from "../contracts/auth.js";

function session(roles: string[], exp = Math.floor(Date.now() / 1000) + 3600, tenant = "t1"): AuthSession {
  return {
    principal: { id: "u1", tenant_id: tenant, display_name: "U", status: "active", roles },
    claims: { user_id: "u1", tenant_id: tenant, roles, exp },
  };
}

describe("role-state", () => {
  it("hasRole / hasAllRoles", () => {
    const s = session([EnterpriseRole.OWNER, EnterpriseRole.FINANCE_ADMIN]);
    expect(hasRole(s, EnterpriseRole.OWNER)).toBe(true);
    expect(hasRole(s, EnterpriseRole.MEMBER)).toBe(false);
    expect(hasAllRoles(s, EnterpriseRole.OWNER, EnterpriseRole.FINANCE_ADMIN)).toBe(true);
    expect(hasAllRoles(s, EnterpriseRole.OWNER, EnterpriseRole.MEMBER)).toBe(false);
  });

  it("null session is never authorized", () => {
    expect(hasRole(null, EnterpriseRole.OWNER)).toBe(false);
    expect(isEnterpriseAdmin(null)).toBe(false);
    expect(isAuthenticated(null)).toBe(false);
    expect(tenantId(null)).toBeNull();
  });

  it("admin/finance/system helpers", () => {
    expect(isEnterpriseAdmin(session([EnterpriseRole.ENTERPRISE_ADMIN]))).toBe(true);
    expect(isFinanceAdmin(session([EnterpriseRole.FINANCE_ADMIN]))).toBe(true);
    expect(isFinanceAdmin(session([EnterpriseRole.MEMBER]))).toBe(false);
    expect(isSystemAdmin(session([PlatformRole.SYSTEM_ADMIN]))).toBe(true);
  });

  it("expired token is not authenticated", () => {
    expect(isAuthenticated(session([EnterpriseRole.OWNER], Math.floor(Date.now() / 1000) - 10))).toBe(false);
  });

  it("tenantId from claims", () => {
    expect(tenantId(session([EnterpriseRole.OWNER], undefined, "tX"))).toBe("tX");
  });
});
