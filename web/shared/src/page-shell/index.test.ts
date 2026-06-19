import { describe, it, expect } from "vitest";
import { buildShellViewModel, type PageShellConfig } from "./index.js";
import { EnterpriseRole } from "../contracts/enums.js";
import type { AuthSession } from "../contracts/auth.js";

const config: PageShellConfig = {
  tier: "manager",
  titleKey: "manager.title",
  nav: [
    { id: "home", labelKey: "nav.home", path: "/" },
    { id: "members", labelKey: "nav.members", path: "/members", requiredRoles: [EnterpriseRole.ENTERPRISE_ADMIN] },
    {
      id: "billing",
      labelKey: "nav.billing",
      path: "/billing",
      requiredRoles: [EnterpriseRole.FINANCE_ADMIN],
      children: [{ id: "invoices", labelKey: "nav.invoices", path: "/billing/invoices" }],
    },
  ],
};

function session(roles: string[]): AuthSession {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return {
    principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles },
    claims: { user_id: "u1", tenant_id: "t1", roles, exp },
  };
}

describe("page-shell buildShellViewModel", () => {
  it("requires login when unauthenticated", () => {
    const vm = buildShellViewModel(config, null, "/");
    expect(vm.requiresLogin).toBe(true);
    expect(vm.nav).toHaveLength(0);
  });

  it("filters nav by role", () => {
    const vm = buildShellViewModel(config, session([EnterpriseRole.ENTERPRISE_ADMIN]), "/members");
    const ids = vm.nav.map((n) => n.id);
    expect(ids).toContain("home");
    expect(ids).toContain("members");
    expect(ids).not.toContain("billing");
    expect(vm.requiresLogin).toBe(false);
  });

  it("resolves active via longest prefix match", () => {
    const vm = buildShellViewModel(config, session([EnterpriseRole.FINANCE_ADMIN]), "/billing/invoices");
    expect(vm.activeItemId).toBe("invoices");
  });

  it("home '/' does not falsely match deeper paths", () => {
    const vm = buildShellViewModel(config, session([EnterpriseRole.ENTERPRISE_ADMIN]), "/members");
    expect(vm.activeItemId).toBe("members");
  });
});
