import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { SolutionsPage } from "../SolutionsPage";
import { useExpertsApi } from "../../experts/useExpertsApi";

vi.mock("../../experts/useExpertsApi", () => ({ useExpertsApi: vi.fn() }));

import type { ExpertsApi } from "../../experts/useExpertsApi";
import type { SolutionInstance } from "../../experts/types";

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

function mockApi(): ExpertsApi {
  const api: ExpertsApi = {
    listTemplates: vi.fn().mockResolvedValue([]),
    listSolutions: vi.fn().mockResolvedValue([{ solution_id: "sol-1", version: "1", display_name: "测试方案" }]),
    recruitExpert: vi.fn().mockResolvedValue({}),
    applySolution: vi.fn().mockResolvedValue({}),
    listEmployees: vi.fn().mockResolvedValue([]),
    updateEmployee: vi.fn().mockResolvedValue(null),
    listSolutionInstances: vi.fn().mockResolvedValue([]),
    transitionEmployee: vi.fn().mockResolvedValue(null),
    getLifecycleOptions: vi.fn().mockResolvedValue({ actions: [] }),
    updateSolutionInstance: vi.fn().mockResolvedValue(null),
  };
  (useExpertsApi as unknown as ReturnType<typeof vi.fn>).mockReturnValue(api);
  return api;
}

function renderPage(roles: string[]) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue(roles)}>
        <MemoryRouter><SolutionsPage /></MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

const solutionInstance: SolutionInstance = {
  id: "si-1", solution_id: "sol-1", solution_version: "v1", display_name: "行业方案A", status: "active",
  expert_employee_ids: ["emp-1", "emp-2"], knowledge_refs: ["ks-shared"], skill_refs: ["skill-shared"],
  planner_prompt: "", subtask_prompt: "", aggregate_prompt: "", created_at: null, updated_at: null,
};

describe("SolutionsPage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it("浏览：渲染可应用方案", async () => {
    mockApi(); renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
  });

  it("应用方案：applySolution(solution_id)", async () => {
    const api = mockApi(); renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    fireEvent.click(screen.getByText("应用方案"));
    await waitFor(() => expect(api.applySolution).toHaveBeenCalledWith({ solution_id: "sol-1" }));
  });

  it("只读成员不显示应用入口", async () => {
    mockApi(); renderPage(["member"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    expect(screen.queryByText("应用方案")).not.toBeInTheDocument();
  });

  it("浏览方案实例卡片", async () => {
    const api = mockApi();
    (api.listSolutionInstances as ReturnType<typeof vi.fn>).mockResolvedValue([solutionInstance]);
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("solution-instance-card")).toBeInTheDocument());
    expect(screen.getByText("行业方案A")).toBeInTheDocument();
  });

  it("编辑方案实例：updateSolutionInstance 收到正确字段", async () => {
    const api = mockApi();
    (api.listSolutionInstances as ReturnType<typeof vi.fn>).mockResolvedValue([solutionInstance]);
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("solution-instance-card")).toBeInTheDocument());
    const card = screen.getByTestId("solution-instance-card");
    fireEvent.click(within(card).getByText("编辑配置"));
    await waitFor(() => expect(within(card).getByLabelText("名称")).toBeInTheDocument());
    fireEvent.change(within(card).getByLabelText("关联专家（employee id）"), { target: { value: "emp-1\nemp-3" } });
    fireEvent.change(within(card).getByLabelText("协作编排 planner prompt"), { target: { value: "拆分任务" } });
    fireEvent.click(within(card).getByText("保存"));
    await waitFor(() => expect(api.updateSolutionInstance).toHaveBeenCalledTimes(1));
    expect(api.updateSolutionInstance).toHaveBeenCalledWith("si-1", expect.objectContaining({
      expert_employee_ids: ["emp-1", "emp-3"], planner_prompt: "拆分任务",
    }));
  });
});
