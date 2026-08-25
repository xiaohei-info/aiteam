import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { DepartmentsPage } from "../DepartmentsPage";
import * as apiModule from "../useDepartmentsApi";
import type { Department } from "../types";

const department: Department = {
  id: "d1",
  department_slug: "engineering",
  display_name: "研发部",
  created_at: "2026-07-01T00:00:00Z",
};

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

function mockApi(overrides: Partial<apiModule.DepartmentsApi> = {}) {
  const api: apiModule.DepartmentsApi = {
    listDepartments: vi.fn().mockResolvedValue([department]),
    getDepartment: vi.fn().mockResolvedValue(department),
    createDepartment: vi.fn().mockResolvedValue(department),
    updateDepartment: vi.fn().mockResolvedValue({ ...department, display_name: "工程部" }),
    deleteDepartment: vi.fn().mockResolvedValue({ deleted: department.id }),
    ...overrides,
  };
  vi.spyOn(apiModule, "useDepartmentsApi").mockReturnValue(api);
  return api;
}

function renderPage(roles: string[] = ["owner"]) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue(roles)}>
        <MemoryRouter>
          <DepartmentsPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("DepartmentsPage 部门管理", () => {
  afterEach(() => vi.restoreAllMocks());

  it("展示部门列表、真实字段和成员分配说明", async () => {
    mockApi();
    renderPage();

    await waitFor(() => expect(screen.getByTestId("department-row")).toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 1, name: "部门管理" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "部门管理" })).toBeInTheDocument();
    expect(screen.getByText("研发部")).toBeInTheDocument();
    expect(screen.getByText("2026-07-01T00:00:00Z")).toBeInTheDocument();
    expect(screen.getByText(/不展示或虚构成员树/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前往成员账号页面" })).toHaveAttribute("href", "/members");
  });

  it("列表加载期间提供可访问 loading 状态", async () => {
    let resolveList: (items: Department[]) => void = () => {};
    const listDepartments = vi.fn(() => new Promise<Department[]>((resolve) => { resolveList = resolve; }));
    mockApi({ listDepartments });
    renderPage();

    expect(screen.getByRole("status", { name: "部门列表加载中" })).toBeInTheDocument();
    resolveList([department]);
    await waitFor(() => expect(screen.getByTestId("department-row")).toBeInTheDocument());
  });

  it("空列表展示空态而不误报为错误", async () => {
    mockApi({ listDepartments: vi.fn().mockResolvedValue([]) });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("departments-empty")).toBeInTheDocument());
    expect(screen.getByText("暂无部门")).toBeInTheDocument();
    expect(screen.queryByTestId("departments-error")).not.toBeInTheDocument();
  });

  it("网络错误展示 offline 提示并支持重试", async () => {
    const listDepartments = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("network down", 0, "network_error"))
      .mockResolvedValueOnce([department]);
    const api = mockApi({ listDepartments });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("departments-error")).toHaveTextContent("无法连接 Manager 服务"));
    fireEvent.click(screen.getByTestId("departments-retry"));
    await waitFor(() => expect(screen.getByTestId("department-row")).toBeInTheDocument());
    expect(api.listDepartments).toHaveBeenCalledTimes(2);
  });

  it.each([
    [403, "requires owner or enterprise_admin", "当前账号没有执行此操作的权限"],
    [503, "Manager DB unavailable", "部门服务暂时不可用"],
  ] as const)("加载错误 %s 显示有界提示和 problem detail", async (status, detail, summary) => {
    mockApi({ listDepartments: vi.fn().mockRejectedValue(new ApiError(detail, status, status === 403 ? "forbidden" : "manager_unavailable")) });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("departments-error")).toHaveTextContent(summary));
    expect(screen.getByTestId("departments-error")).toHaveTextContent(detail);
  });

  it("member 角色只读：不显示写操作并明确权限", async () => {
    mockApi();
    renderPage(["member"]);

    await waitFor(() => expect(screen.getByTestId("department-row")).toBeInTheDocument());
    expect(screen.getByText(/当前账号仅可查看/)).toBeInTheDocument();
    expect(screen.queryByTestId("department-create-trigger")).not.toBeInTheDocument();
    expect(screen.queryByTestId("department-edit-d1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("department-delete-d1")).not.toBeInTheDocument();
  });

  it("owner 创建部门后提交正确 body 并刷新列表", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("department-row")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("department-create-trigger"));
    expect(screen.getByRole("dialog", { name: "新增部门" })).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("department-slug-input"), { target: { value: "sales" } });
    fireEvent.change(screen.getByTestId("department-name-input"), { target: { value: "销售部" } });
    fireEvent.click(screen.getByTestId("department-save"));

    await waitFor(() => expect(api.createDepartment).toHaveBeenCalledWith({
      department_slug: "sales",
      display_name: "销售部",
    }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新增部门" })).not.toBeInTheDocument());
    expect(api.listDepartments).toHaveBeenCalledTimes(2);
  });

  it("编辑部门只提交 display_name，slug 保持不可编辑", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("department-row")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("department-edit-d1"));
    expect(screen.getByRole("dialog", { name: "编辑部门" })).toBeInTheDocument();
    expect(screen.getByTestId("department-slug-input")).toBeDisabled();
    fireEvent.change(screen.getByTestId("department-name-input"), { target: { value: "工程部" } });
    fireEvent.click(screen.getByTestId("department-save"));

    await waitFor(() => expect(api.updateDepartment).toHaveBeenCalledWith("d1", { display_name: "工程部" }));
  });

  it("删除需要确认，冲突时保留确认并展示 problem detail", async () => {
    const api = mockApi({
      deleteDepartment: vi.fn().mockRejectedValue(new ApiError("department still has members", 409, "conflict")),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("department-row")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("department-delete-d1"));
    expect(screen.getByRole("alertdialog", { name: "删除部门" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(api.deleteDepartment).toHaveBeenCalledWith("d1"));
    expect(screen.getByTestId("departments-action-error")).toHaveTextContent("部门操作存在冲突");
    expect(screen.getByTestId("departments-action-error")).toHaveTextContent("department still has members");
    expect(screen.getByRole("alertdialog", { name: "删除部门" })).toBeInTheDocument();
  });
});
