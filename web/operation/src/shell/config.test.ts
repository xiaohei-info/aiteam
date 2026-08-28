/**
 * 运营端壳配置测试（W-O.1）：tier 锁死 operation、导航按平台角色门控。
 * 壳装配逻辑本身在 @aiteam/shared buildShellViewModel（已覆盖），此处只验运营端配置正确。
 */
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { LinkProvider } from "@astryxdesign/core/Link";
import { describe, expect, it } from "vitest";
import {
  buildShellViewModel,
  createI18n,
  PlatformRole,
  sharedMessages,
  type AuthSession,
} from "@aiteam/shared";
import { operationShellConfig } from "./config";
import { AppShell } from "./AppShell";
import { RouterLinkAdapter } from "../astryx/RouterLinkAdapter";
import { SessionContext } from "../auth/session";
import { I18nContext } from "../i18n/context";
import { operationMessages } from "../i18n/messages";

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
      display_name: "u1",
      status: "active",
      roles,
    },
    claims: {
      user_id: "u1",
      roles,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
  };
}

const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
i18n.extend("zh-CN", operationMessages["zh-CN"]!);

function renderShell(): void {
  render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/enterprises"] },
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
                  session: session([PlatformRole.SYSTEM_ADMIN]),
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
                    path: "/enterprises",
                    element: createElement("section", null, "企业开通页"),
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

describe("operation shell config", () => {
  it("以 Astryx 壳渲染命名导航、主内容与当前链接", () => {
    renderShell();

    expect(screen.getByRole("navigation", { name: "Side navigation" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    const currentLink = screen.getByRole("link", { name: "企业开通" });
    expect(currentLink).toHaveAttribute("href", "/enterprises");
    expect(currentLink).toHaveAttribute("aria-current", "page");
    currentLink.focus();
    expect(currentLink).toHaveFocus();
  });

  it("tier 锁死 operation", () => {
    expect(operationShellConfig.tier).toBe("operation");
  });

  it("系统管理员可见全部业务导航", () => {
    const vm = buildShellViewModel(
      operationShellConfig,
      session([PlatformRole.SYSTEM_ADMIN]),
      "/enterprises",
    );
    expect(vm.requiresLogin).toBe(false);
    expect(vm.nav.map((n) => n.id)).toEqual([
      "dashboard",
      "enterprises",
      "accounts",
      "experts",
      "skill-market",
      "providers",
      "industry-solutions",
      "solutions",
      "finance",
      "board",
      "health",
    ]);
    expect(vm.activeItemId).toBe("enterprises");
  });

  it("系统操作员同样可见业务导航", () => {
    const vm = buildShellViewModel(
      operationShellConfig,
      session([PlatformRole.SYSTEM_OPERATOR]),
      "/experts",
    );
    expect(vm.nav.some((n) => n.id === "experts")).toBe(true);
  });

  it("未登录：requiresLogin=true 且导航为空", () => {
    const vm = buildShellViewModel(operationShellConfig, null, "/");
    expect(vm.requiresLogin).toBe(true);
    expect(vm.nav).toEqual([]);
  });

  it("非平台角色（如企业 member）：业务导航被过滤", () => {
    const vm = buildShellViewModel(
      operationShellConfig,
      session(["member"]),
      "/enterprises",
    );
    // 仅 dashboard（无 requiredRoles）可见，enterprises/catalog/board 被过滤。
    expect(vm.nav.map((n) => n.id)).toEqual(["dashboard"]);
  });
});
