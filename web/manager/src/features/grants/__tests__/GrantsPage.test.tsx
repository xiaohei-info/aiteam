/**
 * 成员级授权页测试（W-M.4）：
 * - 列表渲染授权 + 成员/部门名解析
 * - 创建授权：选资源类型/资源 + 成员 → createGrant 收到正确入参
 * - 撤销：deleteGrant
 * - member 只读：无新建表单、无撤销
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { GrantsPage } from "../GrantsPage";
import * as apiModule from "../useGrantsApi";

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", managerMessages["zh-CN"]!);
  return i18n;
}

function sessionValue(roles: string[]): SessionContextValue {
  const session = {
    principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles },
    claims: { user_id: "u1", tenant_id: "t1", roles, exp: Math.floor(Date.now() / 1000) + 3600 },
  } as AuthSession;
  return { session, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };
}

function mockApi(overrides: Partial<apiModule.GrantsApi> = {}) {
  const api: apiModule.GrantsApi = {
    listGrants: vi.fn().mockResolvedValue([
      { id: "g1", resource_type: "expert", resource_id: "e1", department_ids: [], member_ids: ["m1"] },
    ]),
    createGrant: vi.fn().mockResolvedValue({}),
    updateGrant: vi.fn().mockResolvedValue({}),
    deleteGrant: vi.fn().mockResolvedValue(undefined),
    listMembers: vi.fn().mockResolvedValue([{ id: "m1", display_name: "张三" }]),
    listDepartments: vi.fn().mockResolvedValue([{ id: "d1", display_name: "研发部" }]),
    listExperts: vi.fn().mockResolvedValue([{ employee_id: "e1", display_name: "专家A" }]),
    listSolutions: vi.fn().mockResolvedValue([{ id: "s1", display_name: "方案X" }]),
    ...overrides,
  };
  vi.spyOn(apiModule, "useGrantsApi").mockReturnValue(api);
  return api;
}

function renderPage(roles: string[]) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue(roles)}>
        <MemoryRouter>
          <GrantsPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("GrantsPage 成员级授权", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("渲染授权列表 + 成员名解析", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("grant-row")).toBeInTheDocument());
    // member_id m1 在授权行内解析为"张三"（表单下拉也有同名选项，故限定行内）
    expect(within(screen.getByTestId("grant-row")).getByText("张三")).toBeInTheDocument();
  });

  it("创建授权：选专家资源 + 成员 → createGrant 正确入参", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("grant-row")).toBeInTheDocument());

    // resource_type 默认 expert；选资源 e1
    fireEvent.change(screen.getByLabelText("授权资源"), { target: { value: "e1" } });
    // 选成员 m1
    const memberSelect = screen.getByLabelText("成员");
    fireEvent.change(memberSelect, { target: { value: "m1" } });
    fireEvent.click(screen.getByText("授权"));

    await waitFor(() =>
      expect(api.createGrant).toHaveBeenCalledWith({
        resource_type: "expert",
        resource_id: "e1",
        member_ids: ["m1"],
        department_ids: [],
      }),
    );
  });

  it("空授权守卫：只选资源、不选任何成员/部门 → 不提交（D12 不允许空授权）", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("grant-row")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("授权资源"), { target: { value: "e1" } });
    fireEvent.click(screen.getByText("授权"));
    // 无成员无部门 → createGrant 不应被调用
    await Promise.resolve();
    expect(api.createGrant).not.toHaveBeenCalled();
  });

  it("多选聚合：选多个成员 + 部门 → createGrant 收到多元素数组", async () => {
    const api = mockApi({
      listMembers: vi.fn().mockResolvedValue([
        { id: "m1", display_name: "张三" },
        { id: "m2", display_name: "李四" },
      ]),
    });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("grant-row")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("授权资源"), { target: { value: "e1" } });
    // 多选两个成员（jsdom：直接置 option.selected 再触发 change）
    const memberSel = screen.getByLabelText("成员") as HTMLSelectElement;
    Array.from(memberSel.options).forEach((o) => {
      if (o.value === "m1" || o.value === "m2") o.selected = true;
    });
    fireEvent.change(memberSel);
    // 选一个部门
    fireEvent.change(screen.getByLabelText("部门"), { target: { value: "d1" } });
    fireEvent.click(screen.getByText("授权"));

    await waitFor(() =>
      expect(api.createGrant).toHaveBeenCalledWith({
        resource_type: "expert",
        resource_id: "e1",
        member_ids: ["m1", "m2"],
        department_ids: ["d1"],
      }),
    );
  });

  it("撤销：deleteGrant(grant_id)", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("grant-row")).toBeInTheDocument());
    fireEvent.click(screen.getByText("撤销"));
    await waitFor(() => expect(api.deleteGrant).toHaveBeenCalledWith("g1"));
  });

  it("member 只读：无新建表单、无撤销按钮", async () => {
    mockApi();
    renderPage(["member"]);
    await waitFor(() => expect(screen.getByTestId("grant-row")).toBeInTheDocument());
    expect(screen.queryByText("授权")).not.toBeInTheDocument();
    expect(screen.queryByText("撤销")).not.toBeInTheDocument();
  });
});
