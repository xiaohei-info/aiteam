/**
 * 成员账号页测试（W-M.2）：
 * - 列表渲染（listGet 成员）
 * - 创建成员 → 调 createMember + 初始凭据一次性展示
 * - 凭据不写 localStorage
 * - 停启用 → updateMember 切 status
 * - 只读角色（member）不显示创建表单/操作按钮
 * - 只调本端 API（hook 经基类，跨端被 assertOwnTierPath 拦截，由 client.test 守）
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { MembersPage } from "../MembersPage";
import * as apiModule from "../useMembersApi";

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", managerMessages["zh-CN"]!);
  return i18n;
}

function makeSession(roles: string[]): AuthSession {
  return {
    principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles },
    claims: { user_id: "u1", tenant_id: "t1", roles, exp: Math.floor(Date.now() / 1000) + 3600 },
  } as AuthSession;
}

function sessionValue(roles: string[]): SessionContextValue {
  return {
    session: makeSession(roles),
    token: "tok",
    signIn: () => {},
    signOut: () => {},
    onUnauthorized: () => {},
  };
}

const member = {
  id: "m1",
  display_name: "张三",
  status: "active",
  roles: ["member"],
  department_ids: [],
};

function mockApi(overrides: Partial<apiModule.MembersApi> = {}) {
  const api: apiModule.MembersApi = {
    listMembers: vi.fn().mockResolvedValue([member]),
    createMember: vi.fn().mockResolvedValue({ ...member, id: "m2" }),
    updateMember: vi.fn().mockResolvedValue({ ...member, status: "disabled" }),
    deleteMember: vi.fn().mockResolvedValue(undefined),
    listDepartments: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  vi.spyOn(apiModule, "useMembersApi").mockReturnValue(api);
  return api;
}

function renderPage(roles: string[]) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue(roles)}>
        <MemoryRouter>
          <MembersPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("MembersPage 成员账号", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("渲染成员列表", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("张三")).toBeInTheDocument());
    expect(screen.getAllByTestId("member-row")).toHaveLength(1);
    expect(screen.getByRole("table", { name: "成员账号" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "新建成员" })).toBeInTheDocument();
  });

  it("owner 创建成员后一次性展示初始凭据，且不写 localStorage", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("张三")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/账号（手机号）/), { target: { value: "13800000000" } });
    fireEvent.change(screen.getByLabelText(/初始密码/), { target: { value: "pw-secret-123" } });
    fireEvent.click(screen.getByText("创建成员"));

    await waitFor(() => expect(api.createMember).toHaveBeenCalledTimes(1));
    expect(api.createMember).toHaveBeenCalledWith(
      expect.objectContaining({ account: "13800000000", initial_password: "pw-secret-123" }),
    );
    // 一次性凭据展示
    await waitFor(() => expect(screen.getByText("pw-secret-123")).toBeInTheDocument());
    // 不落 localStorage
    expect(JSON.stringify(localStorage)).not.toContain("pw-secret-123");
  });

  it("创建失败时展示错误且不显示任何凭据（凭据红线反向保证）", async () => {
    const api = mockApi({ createMember: vi.fn().mockRejectedValue(new Error("boom")) });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("张三")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/账号（手机号）/), { target: { value: "13800000000" } });
    fireEvent.change(screen.getByLabelText(/初始密码/), { target: { value: "pw-secret-123" } });
    fireEvent.click(screen.getByText("创建成员"));

    await waitFor(() => expect(api.createMember).toHaveBeenCalledTimes(1));
    // 失败后不得展示凭据面板
    expect(screen.queryByText("pw-secret-123")).not.toBeInTheDocument();
    expect(JSON.stringify(localStorage)).not.toContain("pw-secret-123");
  });

  it("停用按钮调 updateMember 切 status=disabled", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("张三")).toBeInTheDocument());

    fireEvent.click(screen.getByText("停用"));
    await waitFor(() => expect(api.updateMember).toHaveBeenCalledWith("m1", { status: "disabled" }));
  });

  it("普通成员（member）只读：无创建表单、无停用按钮", async () => {
    mockApi();
    renderPage(["member"]);
    await waitFor(() => expect(screen.getByText("张三")).toBeInTheDocument());
    expect(screen.queryByText("创建成员")).not.toBeInTheDocument();
    expect(screen.queryByText("停用")).not.toBeInTheDocument();
    expect(screen.queryByText("删除")).not.toBeInTheDocument();
  });

  it("owner 删除成员：点删除→二次确认→确认调 deleteMember，成功后该行消失", async () => {
    const api = mockApi({
      listMembers: vi
        .fn()
        .mockResolvedValueOnce([member])
        .mockResolvedValueOnce([]),
    });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("张三")).toBeInTheDocument());

    fireEvent.click(screen.getByText("删除"));
    await waitFor(() => expect(screen.getByRole("alertdialog", { name: "删除成员" })).toBeInTheDocument());

    fireEvent.click(screen.getByText("确认删除"));
    await waitFor(() => expect(api.deleteMember).toHaveBeenCalledWith("m1"));
    await waitFor(() => expect(api.listMembers).toHaveBeenCalledTimes(2));
  });

  it("删除成员时点取消：不调用 deleteMember，恢复启用/停用按钮", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("张三")).toBeInTheDocument());

    fireEvent.click(screen.getByText("删除"));
    await waitFor(() => expect(screen.getByRole("alertdialog", { name: "删除成员" })).toBeInTheDocument());

    fireEvent.click(screen.getByText("取消"));
    expect(api.deleteMember).not.toHaveBeenCalled();
    expect(screen.getByText("停用")).toBeInTheDocument();
    expect(screen.getByText("删除")).toBeInTheDocument();
  });

  it("加载失败显示错误 Banner", async () => {
    mockApi({ listMembers: vi.fn().mockRejectedValue(new Error("boom")) });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("成员列表加载失败"));
  });
});
