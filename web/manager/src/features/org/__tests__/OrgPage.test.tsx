/**
 * 组织架构页测试：
 * - 渲染组织树
 * - 加载失败展示错误
 * - 空树展示空态
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { OrgPage } from "../OrgPage";
import * as apiModule from "../useOrgApi";

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", managerMessages["zh-CN"]!);
  return i18n;
}

function sessionValue(): SessionContextValue {
  const session = {
    principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles: ["owner"] },
    claims: { user_id: "u1", tenant_id: "t1", roles: ["owner"], exp: Math.floor(Date.now() / 1000) + 3600 },
  } as AuthSession;
  return { session, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };
}

const tree = {
  id: "root", type: "department", name: "企业", parent_id: null, status: null,
  children: [
    { id: "d1", type: "department", name: "研发部", parent_id: "root", status: null, children: [
      { id: "e1", type: "employee", name: "张三", parent_id: "d1", status: "online", children: [] },
    ]},
  ],
};
const treeNoDept = {
  id: "root",
  type: "organization",
  name: "企业",
  parent_id: null,
  status: null,
  children: [{ id: "e1", type: "employee", name: "张三", parent_id: "root", status: "online", children: [] }],
};

function mockApi(overrides: Partial<apiModule.OrgApi> = {}) {
  const api: apiModule.OrgApi = {
    getTree: vi.fn().mockResolvedValue(tree),
    assignDepartment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  vi.spyOn(apiModule, "useOrgApi").mockReturnValue(api);
  return api;
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue()}>
        <MemoryRouter>
          <OrgPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("OrgPage 组织架构", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染组织树", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(3));
    expect(screen.getByText("企业")).toBeInTheDocument();
    expect(screen.getByText("研发部")).toBeInTheDocument();
    expect(screen.getByText("张三")).toBeInTheDocument();
    expect(screen.getByRole("tree", { name: "组织树" })).toBeInTheDocument();
  });

  it("加载失败展示错误", async () => {
    mockApi({ getTree: vi.fn().mockRejectedValue(new ApiError("组织服务不可用", 503, "org_unavailable")) });
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("组织服务不可用"));
  });

  it("空数据展示空态", async () => {
    mockApi({ getTree: vi.fn().mockResolvedValue(null) });
    renderPage();
    await waitFor(() => expect(screen.getByText("暂无数据")).toBeInTheDocument());
  });

  it("员工节点在有部门时可触发部门分配 → 调 assignDepartment", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText("张三")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("assign-trigger-e1"));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "分配部门" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("combobox", { name: /选择部门/ }));
    fireEvent.click(screen.getByRole("option", { name: "研发部", hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: "分配" }));

    await waitFor(() => expect(api.assignDepartment).toHaveBeenCalledWith("e1", "d1"));
    await waitFor(() => expect(api.getTree).toHaveBeenCalledTimes(2));
  });

  it("无部门时不显示分配按钮", async () => {
    mockApi({ getTree: vi.fn().mockResolvedValue(treeNoDept) });
    renderPage();
    await waitFor(() => expect(screen.getByText("张三")).toBeInTheDocument());
    expect(screen.queryByTestId("assign-trigger-e1")).not.toBeInTheDocument();
  });

  it("分配失败展示错误文案", async () => {
    mockApi({
      assignDepartment: vi
        .fn()
        .mockRejectedValue(new ApiError("分配失败，请重试", 500, "assign_failed")),
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("张三")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("assign-trigger-e1"));
    await waitFor(() => expect(screen.getByTestId("assign-modal")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("combobox", { name: /选择部门/ }));
    fireEvent.click(screen.getByRole("option", { name: "研发部", hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: "分配" }));

    await waitFor(() => expect(screen.getByText("分配失败，请重试")).toBeInTheDocument());
    expect(screen.queryByTestId("assign-success")).not.toBeInTheDocument();
  });
});
