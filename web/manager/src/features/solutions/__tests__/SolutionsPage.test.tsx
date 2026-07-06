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
import type { SolutionInstance, SolutionPackage } from "../../experts/types";

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
    listSolutions: vi.fn().mockResolvedValue([{
      solution_id: "sol-1", version: "1", display_name: "测试方案",
      experts: [{ template_id: "tpl-1", version: "1", display_name: "架构师", persona: "技术架构专家", category: "tech" }],
      knowledge_refs: ["ks-shared"], skill_refs: ["skill-a"], tags: ["金融"], planner_prompt: "",
    } as SolutionPackage]),
    recruitExpert: vi.fn().mockResolvedValue({}),
    applySolution: vi.fn().mockResolvedValue({}),
    listEmployees: vi.fn().mockResolvedValue([]),
    updateEmployee: vi.fn().mockResolvedValue(null),
    listSolutionInstances: vi.fn().mockResolvedValue([]),
    transitionEmployee: vi.fn().mockResolvedValue(null),
    getLifecycleOptions: vi.fn().mockResolvedValue({ actions: [] }),
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

  it("查看方案详情：点击查看详情打开抽屉展示专家/知识/技能", async () => {
    mockApi(); renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    fireEvent.click(screen.getByText("查看详情"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("架构师")).toBeInTheDocument();
    expect(screen.getByText("ks-shared")).toBeInTheDocument();
    expect(screen.getByText("skill-a")).toBeInTheDocument();
    // 关闭
    fireEvent.click(screen.getByText("✕"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("浏览方案实例卡片（只读，无编辑按钮）", async () => {
    const api = mockApi();
    (api.listSolutionInstances as ReturnType<typeof vi.fn>).mockResolvedValue([solutionInstance]);
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("solution-instance-card")).toBeInTheDocument());
    expect(screen.getByText("行业方案A")).toBeInTheDocument();
    expect(screen.queryByText("编辑配置")).not.toBeInTheDocument();
  });

  it("加载失败：listSolutions 报错显示错误信息", async () => {
    const api = mockApi();
    (api.listSolutions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("加载失败")).toBeInTheDocument());
  });

  it("空状态：无方案时显示空提示", async () => {
    const api = mockApi();
    (api.listSolutions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("暂无可应用方案")).toBeInTheDocument());
  });

  it("应用方案失败：applySolution 报错显示操作失败", async () => {
    const api = mockApi();
    (api.applySolution as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("nope"));
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    fireEvent.click(screen.getByText("应用方案"));
    await waitFor(() => expect(screen.getByText("操作失败，请重试")).toBeInTheDocument());
  });

  it("应用方案成功：显示成功提示", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    fireEvent.click(screen.getByText("应用方案"));
    await waitFor(() => expect(screen.getByText("方案已应用")).toBeInTheDocument());
  });

  const inactiveInstance: SolutionInstance = {
    ...solutionInstance, id: "si-2", status: "inactive",
    expert_employee_ids: [], knowledge_refs: [], skill_refs: [],
  };

  it("非 active 状态：实例卡显示非高亮状态标签", async () => {
    const api = mockApi();
    (api.listSolutionInstances as ReturnType<typeof vi.fn>).mockResolvedValue([inactiveInstance]);
    renderPage(["owner"]);
    const card = await screen.findByTestId("solution-instance-card");
    expect(within(card).getByText("inactive")).toBeInTheDocument();
  });


  it("应用方案成功：显示前往专家实例配置入口", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    fireEvent.click(screen.getByText("应用方案"));
    await waitFor(() => expect(screen.getByTestId("goto-experts")).toBeInTheDocument());
    expect(screen.getByTestId("goto-experts")).toHaveAttribute("href", "/experts");
  });
});
