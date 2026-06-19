import { describe, it, expect } from "vitest";
import {
  ConversationState,
  DisplayState,
  EnterpriseRole,
  PlatformRole,
  AuthProvider,
  IsolationLevel,
} from "./enums.js";

/**
 * 反跑偏断言：前端枚举镜像值集必须与 server/shared/contracts/enums.py 完全一致。
 * 若服务端改了取值而前端没同步，这里立刻红。
 */
describe("enums mirror server contract", () => {
  it("ConversationState values", () => {
    expect(Object.values(ConversationState).sort()).toEqual(
      ["active", "archived", "draft", "muted", "paused"].sort(),
    );
  });

  it("DisplayState values", () => {
    expect(Object.values(DisplayState).sort()).toEqual(
      ["busy", "idle", "reconnecting", "resolved", "routing", "streaming", "waiting_reply"].sort(),
    );
  });

  it("EnterpriseRole values (no legacy admin/manager/viewer)", () => {
    const values = Object.values(EnterpriseRole);
    expect(values.sort()).toEqual(
      ["enterprise_admin", "finance_admin", "member", "owner"].sort(),
    );
    expect(values).not.toContain("admin");
    expect(values).not.toContain("manager");
    expect(values).not.toContain("viewer");
  });

  it("PlatformRole values", () => {
    expect(Object.values(PlatformRole).sort()).toEqual(
      ["system_admin", "system_operator"].sort(),
    );
  });

  it("AuthProvider values", () => {
    expect(Object.values(AuthProvider).sort()).toEqual(
      ["password", "phone", "wechat"].sort(),
    );
  });

  it("IsolationLevel values", () => {
    expect(Object.values(IsolationLevel).sort()).toEqual(
      ["l1_shared_rls", "l2_schema_per_tenant", "l3_db_per_tenant"].sort(),
    );
  });
});
