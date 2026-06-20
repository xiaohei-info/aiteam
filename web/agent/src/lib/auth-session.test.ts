/**
 * auth-session 派生测试：claims → AuthSession 形状正确。
 */

import { describe, expect, it } from "vitest";

import { sessionFromClaims } from "./auth-session";

describe("sessionFromClaims", () => {
  it("claims 派生 AuthSession（display_name 兜底 user_id）", () => {
    const claims = {
      user_id: "u-1",
      tenant_id: "t-1",
      enterprise_id: "e-1",
      roles: ["member"],
      exp: 9999,
    };
    const session = sessionFromClaims(claims);
    expect(session.principal.id).toBe("u-1");
    expect(session.principal.tenant_id).toBe("t-1");
    expect(session.principal.display_name).toBe("u-1");
    expect(session.principal.roles).toEqual(["member"]);
    expect(session.claims).toBe(claims);
  });

  it("无 tenant/enterprise 时为 null（非 undefined）", () => {
    const session = sessionFromClaims({ user_id: "u-2", roles: [], exp: 1 });
    expect(session.principal.tenant_id).toBeNull();
    expect(session.principal.enterprise_id).toBeNull();
  });
});
