/**
 * 组织架构页测试：
 * - 渲染组织树
 * - 加载失败展示错误
 * - 空树展示空态
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
    await waitFor(() => expect(screen.getAllByTestId("org-node")).toHaveLength(3));
    expect(screen.getByText("企业")).toBeInTheDocument();
    expect(screen.getByText("研发部")).toBeInTheDocument();
    expect(screen.getByText("张三")).toBeInTheDocument();
  });

  it("加载失败展示错误", async () => {
    mockApi({ getTree: vi.fn().mockRejectedValue(new ApiError("组织服务不可用", 503, "org_unavailable")) });
    renderPage();
    await waitFor(() => expect(screen.getByText("组织服务不可用")).toBeInTheDocument());
  });

  it("空数据展示空态", async () => {
    mockApi({ getTree: vi.fn().mockResolvedValue(null) });
    renderPage();
    await waitFor(() => expect(screen.getByText("暂无数据")).toBeInTheDocument());
  });
});
