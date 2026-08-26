/**
 * 企业端壳配置测试（W-M）：tier 锁死 manager、导航按企业角色门控。
 * 壳装配逻辑本身在 @aiteam/shared buildShellViewModel（已覆盖），此处只验企业端配置正确。
 * 红线：只用 EnterpriseRole（owner / enterprise_admin / finance_admin / member），禁旧 admin/manager/viewer。
 *
 * 导航覆盖企业后台的 13 个入口，Provider/模型仅使用 Operator 平台目录。
 * 「协作编排」菜单已清理：对应后端 collaboration_template 表是死数据，Agent 群聊不读它（AITEAM-374）。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { LinkProvider } from "@astryxdesign/core/Link";
import {
  buildShellViewModel,
  createI18n,
  EnterpriseRole,
  sharedMessages,
  type AuthSession,
} from "@aiteam/shared";
import { managerShellConfig } from "./config";
import { AppShell } from "./AppShell";
import { RouterLinkAdapter } from "../astryx/RouterLinkAdapter";
import { SessionContext } from "../auth/session";
import { I18nContext } from "../i18n/context";
import { managerMessages } from "../i18n/messages";

if (typeof window !== "undefined" && !window.matchMedia) {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

function session(roles: string[]): AuthSession {
  return {
    principal: {
      id: "u1",
      tenant_id: "t1",
      display_name: "u1",
      status: "active",
      roles,
    },
    claims: {
      user_id: "u1",
      tenant_id: "t1",
      roles,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
  };
}

const ALL_NAV_IDS = [
  "members",
  "departments",
  "solutions",
  "skills",
  "marketplace",
  "experts",
  "grants",
  "memory",
  "knowledge",
  "connectors",
  "billing",
  "recharge",
  "settings",
] as const;

const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
i18n.extend("zh-CN", managerMessages["zh-CN"]!);

function renderShellAtMembers(): void {
  render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/members"] },
      createElement(
        LinkProvider,
        {
          component: RouterLinkAdapter,
          children: createElement(
            I18nContext.Provider,
            { value: i18n },
            createElement(
              SessionContext.Provider,
              {
                value: {
                  session: session([EnterpriseRole.OWNER]),
                  token: "test-token",
                  signIn: () => undefined,
                  signOut: () => undefined,
                  onUnauthorized: () => undefined,
                },
              },
              createElement(
                Routes,
                null,
                createElement(
                  Route,
                  { element: createElement(AppShell) },
                  createElement(Route, {
                    path: "/members",
                    element: createElement("div", null, "成员页"),
                  }),
                ),
              ),
            ),
          ),
        },
      ),
    ),
  );
}

describe("manager shell config", () => {
  it("以 Astryx 侧栏语义渲染当前成员账号导航", () => {
    renderShellAtMembers();

    expect(
      screen.getByRole("navigation", { name: "Side navigation" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "成员账号" })).toHaveAttribute(
      "href",
      "/members",
    );
    expect(screen.getByRole("link", { name: "成员账号" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("tier 锁死 manager", () => {
    expect(managerShellConfig.tier).toBe("manager");
  });

  it("导航覆盖企业管理入口（13 项）", () => {
    const navIds = managerShellConfig.nav.map((n) => n.id);
    expect(navIds).toEqual([...ALL_NAV_IDS]);
    expect(navIds).toHaveLength(13);
  });

  it("owner 可见全部 13 项导航", () => {
    const vm = buildShellViewModel(
      managerShellConfig,
      session([EnterpriseRole.OWNER]),
      "/members",
    );
    expect(vm.requiresLogin).toBe(false);
    expect(vm.nav.map((n) => n.id)).toEqual([...ALL_NAV_IDS]);
    expect(vm.activeItemId).toBe("members");
  });

  it("enterprise_admin 可见管理项（费用/充值被 view_billing 过滤）", () => {
    const vm = buildShellViewModel(
      managerShellConfig,
      session([EnterpriseRole.ENTERPRISE_ADMIN]),
      "/members",
    );
    expect(vm.nav.map((n) => n.id)).toEqual([
      "members",
      "departments",
      "solutions",
      "skills",
      "marketplace",
      "experts",
      "grants",
      "memory",
      "knowledge",
      "connectors",
      "settings",
    ]);
  });

  it("finance_admin 只见无角色门控项 + 费用/充值", () => {
    const vm = buildShellViewModel(
      managerShellConfig,
      session([EnterpriseRole.FINANCE_ADMIN]),
      "/billing",
    );
    expect(vm.nav.map((n) => n.id)).toEqual([
      "departments",
      "solutions",
      "memory",
      "knowledge",
      "billing",
      "recharge",
      "settings",
    ]);
    expect(vm.activeItemId).toBe("billing");
  });

  it("member 只见无角色门控项（员工/技能/人才市场/连接器/费用/充值被过滤）", () => {
    const vm = buildShellViewModel(
      managerShellConfig,
      session([EnterpriseRole.MEMBER]),
      "/solutions",
    );
    expect(vm.nav.map((n) => n.id)).toEqual([
      "departments",
      "solutions",
      "memory",
      "knowledge",
      "settings",
    ]);
  });

  it("未登录：requiresLogin=true 且导航为空", () => {
    const vm = buildShellViewModel(managerShellConfig, null, "/");
    expect(vm.requiresLogin).toBe(true);
    expect(vm.nav).toEqual([]);
  });

  it("skills 导航指向平台技能市场", () => {
    const skillsItem = managerShellConfig.nav.find((n) => n.id === "skills");
    expect(skillsItem?.path).toBe("/skill-market");
  });

  it("recharge 导航指向 /recharge", () => {
    const rechargeItem = managerShellConfig.nav.find((n) => n.id === "recharge");
    expect(rechargeItem?.path).toBe("/recharge");
  });
});
