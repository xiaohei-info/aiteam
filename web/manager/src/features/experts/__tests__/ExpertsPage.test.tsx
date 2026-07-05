/**
 * 招募专家页测试（W-M.3）：
 * - 浏览：渲染可招募模板/方案 + 已招募实例（含模型/运行时/能力/记忆）
 * - 招募：填 slug → recruitExpert(template_id, slug)
 * - 应用方案：applySolution(solution_id)
 * - 编辑实例：改 persona/模型/能力 → updateEmployee 收到全量配置 + 改后值（保全其余字段）
 * - 只读角色（member）不显示招募/应用/编辑入口
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { ExpertsPage } from "../ExpertsPage";
import * as apiModule from "../useExpertsApi";
import type { EmployeeConfig, SolutionInstance } from "../types";

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

const employee: EmployeeConfig = {
  employee_id: "e1",
  employee_slug: "exp-a",
  version: 1,
  display_name: "专家A",
  persona: "原人设",
  model_policy: { model: "claude-opus-4-8", provider_ref: "relay", thinking_level: "high" },
  runtime_policy: { runtime_binding: "hermes_acp", timeout_seconds: 120 },
  tools: ["search"],
  skills: ["code-review"],
  knowledge_refs: ["ks1"],
  connector_refs: ["slack"],
  memory_policy: { seed: "x" },
  status: "active",
};

function mockApi(overrides: Partial<apiModule.ExpertsApi> = {}) {
  const api: apiModule.ExpertsApi = {
    listTemplates: vi.fn().mockResolvedValue([
      { template_id: "tpl-1", version: "1", display_name: "测试专家" },
    ]),
    listSolutions: vi.fn().mockResolvedValue([
      { solution_id: "sol-1", version: "1", display_name: "测试方案" },
    ]),
    recruitExpert: vi.fn().mockResolvedValue({}),
    applySolution: vi.fn().mockResolvedValue({}),
    listEmployees: vi.fn().mockResolvedValue([employee]),
    updateEmployee: vi.fn().mockResolvedValue(employee),
    transitionEmployee: vi.fn().mockResolvedValue(employee),
    getLifecycleOptions: vi.fn().mockResolvedValue({
      allowed_transitions: ["pause", "archive"],
      is_runnable: true,
      is_provisionable: false,
    }),
    listSolutionInstances: vi.fn().mockResolvedValue([]),
    updateSolutionInstance: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
  vi.spyOn(apiModule, "useExpertsApi").mockReturnValue(api);
  return api;
}

function renderPage(roles: string[]) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue(roles)}>
        <MemoryRouter>
          <ExpertsPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("ExpertsPage 招募专家", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("浏览：渲染可招募模板/方案 + 已招募实例", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    expect(screen.getByText("测试方案")).toBeInTheDocument();
    expect(screen.getByTestId("instance-row")).toBeInTheDocument();
  });

  it("招募：填 slug → recruitExpert(template_id + slug)", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("实例标识（slug）"), { target: { value: "exp-new" } });
    fireEvent.click(screen.getByText("招募"));
    await waitFor(() =>
      expect(api.recruitExpert).toHaveBeenCalledWith({ template_id: "tpl-1", employee_slug: "exp-new" }),
    );
  });

  it("应用方案：applySolution(solution_id)", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    fireEvent.click(screen.getByText("应用方案"));
    await waitFor(() => expect(api.applySolution).toHaveBeenCalledWith({ solution_id: "sol-1" }));
  });

  it("编辑实例：改 persona → updateEmployee 收全量配置 + 新 persona，保全其余字段", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("instance-row")).toBeInTheDocument());

    fireEvent.click(screen.getByText("编辑配置"));
    await waitFor(() => expect(screen.getByLabelText("模型")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("人设（persona）"), { target: { value: "新人设" } });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => expect(api.updateEmployee).toHaveBeenCalledTimes(1));
    // 全量回传：改后 persona + 保全【全部】其余字段（坐实 PUT 全量不丢任何字段）。
    expect(api.updateEmployee).toHaveBeenCalledWith(
      "e1",
      expect.objectContaining({
        display_name: "专家A",
        persona: "新人设",
        model_policy: employee.model_policy,
        runtime_policy: employee.runtime_policy,
        tools: employee.tools,
        skills: employee.skills,
        knowledge_refs: employee.knowledge_refs,
        connector_refs: employee.connector_refs,
        memory_policy: employee.memory_policy,
      }),
    );
  });

  it("普通成员（member）只读：无招募/应用/编辑入口", async () => {
    mockApi();
    renderPage(["member"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    expect(screen.queryByText("招募")).not.toBeInTheDocument();
    expect(screen.queryByText("应用方案")).not.toBeInTheDocument();
    expect(screen.queryByText("编辑配置")).not.toBeInTheDocument();
  });

  it("浏览：已招募实例渲染完整配置项（模型/运行时/能力/记忆）", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("instance-row")).toBeInTheDocument());

    // 模型 + provider + 运行时
    expect(screen.getByText("claude-opus-4-8")).toBeInTheDocument();
    expect(screen.getByText("relay")).toBeInTheDocument();
    expect(screen.getByText("hermes_acp")).toBeInTheDocument();
    // 列表字段逗号展示
    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(screen.getByText("ks1")).toBeInTheDocument();
    expect(screen.getByText("slack")).toBeInTheDocument();
    // 记忆策略（JSON 序列化展示）
    expect(screen.getByText(JSON.stringify(employee.memory_policy))).toBeInTheDocument();
  });

  it("编辑实例：改模型与思考深度 → updateEmployee 收新 model_policy 并保全其余", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("instance-row")).toBeInTheDocument());

    fireEvent.click(screen.getByText("编辑配置"));
    await waitFor(() => expect(screen.getByLabelText("模型")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "claude-sonnet-4-20250514" } });
    fireEvent.change(screen.getByLabelText("Provider 引用"), { target: { value: "anthropic" } });
    const thinkingSelect = screen.getByLabelText("思考深度") as HTMLSelectElement;
    fireEvent.change(thinkingSelect, { target: { value: "deep" } });
    fireEvent.change(screen.getByLabelText("技能"), { target: { value: "code-review\nwriting" } });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => expect(api.updateEmployee).toHaveBeenCalledTimes(1));
    expect(api.updateEmployee).toHaveBeenCalledWith(
      "e1",
      expect.objectContaining({
        display_name: "专家A",
        model_policy: { model: "claude-sonnet-4-20250514", provider_ref: "anthropic", thinking_level: "deep" },
        skills: ["code-review", "writing"],
        // 其余原值保全
        tools: employee.tools,
        knowledge_refs: employee.knowledge_refs,
        connector_refs: employee.connector_refs,
        memory_policy: employee.memory_policy,
      }),
    );
  });

  it("编辑实例：空数组输入 → tools/skills 传 [] 而非字符串", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("instance-row")).toBeInTheDocument());

    fireEvent.click(screen.getByText("编辑配置"));
    await waitFor(() => expect(screen.getByLabelText("模型")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("工具"), { target: { value: "" } });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => expect(api.updateEmployee).toHaveBeenCalledTimes(1));
    expect(api.updateEmployee).toHaveBeenCalledWith(
      "e1",
      expect.objectContaining({ tools: [] }),
    );
  });

  it("生命周期：active 状态显示暂停/归档按钮（来自 getLifecycleOptions）", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("instance-row")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("暂停")).toBeInTheDocument());
    expect(screen.getByText("归档")).toBeInTheDocument();
  });

  it("生命周期：draft 状态显示开始配置/激活/归档按钮", async () => {
    mockApi({
      listEmployees: vi.fn().mockResolvedValue([{ ...employee, status: "draft" }]),
      getLifecycleOptions: vi.fn().mockResolvedValue({
        allowed_transitions: ["provision", "activate", "archive"],
        is_runnable: false,
        is_provisionable: true,
      }),
    });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("开始配置")).toBeInTheDocument());
    expect(screen.getByText("激活")).toBeInTheDocument();
    expect(screen.getByText("归档")).toBeInTheDocument();
  });

  it("生命周期：点击暂停 → transitionEmployee(pause)", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("instance-row")).toBeInTheDocument());
    fireEvent.click(screen.getByText("暂停"));
    await waitFor(() => expect(api.transitionEmployee).toHaveBeenCalledWith("e1", "pause", undefined));
  });

  it("普通成员不显示生命周期按钮", async () => {
    mockApi();
    renderPage(["member"]);
    await waitFor(() => expect(screen.getByTestId("instance-row")).toBeInTheDocument());
    expect(screen.queryByText("暂停")).not.toBeInTheDocument();
    expect(screen.queryByText("归档")).not.toBeInTheDocument();
  });

  const solutionInstance: SolutionInstance = {
    id: "si-1",
    solution_id: "sol-1",
    solution_version: "v1",
    display_name: "行业方案A",
    status: "applied",
    expert_employee_ids: ["emp-1", "emp-2"],
    knowledge_refs: ["ks-shared"],
    skill_refs: ["skill-shared"],
    planner_prompt: "",
    subtask_prompt: "",
    aggregate_prompt: "",
    created_at: null,
    updated_at: null,
  };

  it("浏览：已应用方案实例渲染专家绑定与引用", async () => {
    mockApi({ listSolutionInstances: vi.fn().mockResolvedValue([solutionInstance]) });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("solution-instance-card")).toBeInTheDocument());
    expect(screen.getByText("行业方案A")).toBeInTheDocument();
    expect(screen.getByText("emp-1")).toBeInTheDocument();
    expect(screen.getByText("emp-2")).toBeInTheDocument();
  });

  it("普通成员（member）方案实例只读：无编辑配置入口", async () => {
    mockApi({ listSolutionInstances: vi.fn().mockResolvedValue([solutionInstance]) });
    renderPage(["member"]);
    await waitFor(() => expect(screen.getByTestId("solution-instance-card")).toBeInTheDocument());
    expect(screen.queryByText("编辑配置")).not.toBeInTheDocument();
  });

  it("操作失败：runAction 捕获异常并显示错误", async () => {
    mockApi({ listEmployees: vi.fn().mockRejectedValue(new Error("网络错误")) });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("加载失败")).toBeInTheDocument());
  });

  it("操作失败：action runAction 捕获 ApiError 并显示错误", async () => {
    mockApi({
      recruitExpert: vi.fn().mockRejectedValue(new Error("招募失败")),
    });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("招募")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("实例标识（slug）"), { target: { value: "exp-x" } });
    fireEvent.click(screen.getByText("招募"));
    await waitFor(() => expect(screen.getByText("操作失败，请重试")).toBeInTheDocument());
  });

  it("导出 CSV：handleExport 调用 fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Blob(["x"], { type: "text/csv" }), { status: 200 }),
    );
    // Mock URL methods
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn().mockReturnValue("blob:mock");
    URL.revokeObjectURL = vi.fn();

    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("导出 CSV")).toBeInTheDocument());
    fireEvent.click(screen.getByText("导出 CSV"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/manager/employees/export/all", expect.objectContaining({ headers: expect.anything() })));

    fetchMock.mockRestore();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  });
});
