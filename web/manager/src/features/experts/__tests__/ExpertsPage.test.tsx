import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { ExpertsPage } from "../ExpertsPage";
import { useExpertsApi } from "../useExpertsApi";
import { usePlatformModelsApi } from "../../platform-models/usePlatformModelsApi";

vi.mock("../useExpertsApi", () => ({ useExpertsApi: vi.fn() }));
vi.mock("../../platform-models/usePlatformModelsApi", () => ({ usePlatformModelsApi: vi.fn() }));

import type { ExpertsApi } from "../useExpertsApi";
import type { EmployeeConfig } from "../types";
import type { ProviderCredential } from "../../providers/types";
import { toEmployeeConfigIn } from "../EmployeeConfigDrawer";

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

const provider: ProviderCredential = {
  credential_id: "cred-1",
  provider_ref: "openai-main",
  display_name: "OpenAI",
  api_protocol: "openai-completions",
  endpoint: null,
  visibility: "tenant",
  allowed_member_ids: [],
  version: 1,
  supported_models: [
    { model: "gpt-4o", display_name: "GPT-4o", enabled: true },
    { model: "gpt-4o-mini", display_name: "GPT-4o mini", enabled: true },
  ],
};

const providerB: ProviderCredential = {
  credential_id: "cred-2",
  provider_ref: "anthropic-main",
  display_name: "Anthropic",
  api_protocol: "anthropic-messages",
  endpoint: null,
  visibility: "tenant",
  allowed_member_ids: [],
  version: 1,
  supported_models: [
    { model: "claude-3-5-sonnet", display_name: "Claude 3.5 Sonnet", enabled: true },
  ],
};

const employeeConfigured: EmployeeConfig = {
  employee_id: "emp-1",
  employee_slug: "architect",
  version: 1,
  display_name: "架构师",
  persona: "技术架构专家",
  model_policy: { model: "gpt-4o", provider_ref: "openai-main", provider_version: 1, model_version: 1, thinking_level: "basic" },
  execution_policy: { timeout_seconds: 60 },
  tools: ["t1"],
  skills: ["s1"],
  knowledge_refs: ["k1"],
  connector_refs: [],
  memory_policy: null,
  status: "active",
};

const employeeUnconfigured: EmployeeConfig = {
  employee_id: "emp-2",
  employee_slug: "researcher",
  version: 1,
  display_name: "研究员",
  persona: null,
  model_policy: { model: "", provider_ref: null, thinking_level: null },
  execution_policy: { timeout_seconds: null },
  tools: [],
  skills: [],
  knowledge_refs: [],
  connector_refs: [],
  memory_policy: null,
  status: "draft",
};

function mockApis(
  employees: EmployeeConfig[],
  providers: ProviderCredential[] = [provider],
): {
  api: ExpertsApi;
  updateEmployee: ReturnType<typeof vi.fn>;
} {
  const updateEmployee = vi.fn().mockImplementation(async (_id: string, cfg: EmployeeConfig) => cfg);
  const api: ExpertsApi = {
    listTemplates: vi.fn().mockResolvedValue([]),
    listSolutions: vi.fn().mockResolvedValue([]),
    recruitExpert: vi.fn().mockResolvedValue({}),
    applySolution: vi.fn().mockResolvedValue({}),
    listEmployees: vi.fn().mockResolvedValue(employees),
    updateEmployee,
    listSolutionInstances: vi.fn().mockResolvedValue([]),
    transitionEmployee: vi.fn().mockResolvedValue(null),
    getLifecycleOptions: vi.fn().mockResolvedValue({ actions: [] }),
  };
  (useExpertsApi as unknown as ReturnType<typeof vi.fn>).mockReturnValue(api);
  (usePlatformModelsApi as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    list: vi.fn().mockResolvedValue({
      providers: providers.map((item) => ({ provider_id: item.provider_ref, provider_code: item.provider_ref, display_name: item.display_name, status: "published", version: item.version })),
      models: providers.flatMap((item) => (item.supported_models ?? []).map((model) => ({
        model: {
          provider_id: item.provider_ref,
          model_id: model.model,
          display_name: model.display_name,
          status: "published",
          version: 1,
          capabilities: model.model === "minimax-m3"
            ? { reasoning: true, thinking_mode: "toggle", thinking_levels: ["off", "high"] }
            : model.model === "gpt-4o"
              ? { reasoning: true, thinking_level_map: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null } }
              : undefined,
        },
        rate: { pricing_version: 1, pricing_status: "known", input_usd_per_million: "1", output_usd_per_million: "2", cache_read_usd_per_million: null, cache_write_usd_per_million: null, currency: "USD" },
      }))),
    }),
  });
  return { api, updateEmployee };
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue()}>
        <MemoryRouter><ExpertsPage /></MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("ExpertsPage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it("列表：展示本 tenant 已招募专家名称 / 状态 / model / 配置状态", async () => {
    mockApis([employeeConfigured, employeeUnconfigured]);
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("employee-row")[0]!).toBeInTheDocument());
    expect(screen.getAllByTestId("employee-row")).toHaveLength(2);
    expect(screen.getByText("架构师")).toBeInTheDocument();
    expect(screen.queryByText("architect")).not.toBeInTheDocument();
    expect(screen.queryByText("openai-main")).not.toBeInTheDocument();
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    expect(screen.getByTestId("employee-list")).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("搜索与待处理筛选只展示匹配的专家卡片", async () => {
    mockApis([employeeConfigured, employeeUnconfigured]);
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("employee-row")).toHaveLength(2));

    fireEvent.change(screen.getByRole("textbox", { name: "搜索专家" }), { target: { value: "研究" } });
    expect(screen.getAllByTestId("employee-row")).toHaveLength(1);
    expect(screen.getByRole("article", { name: "研究员" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索专家" }), { target: { value: "" } });
    fireEvent.click(within(screen.getByRole("group", { name: "专家实例筛选" })).getByRole("button", { name: "待处理" }));
    expect(screen.queryByRole("article", { name: "架构师" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "研究员" })).toBeInTheDocument();
  });

  it("列表展示员工所属部门", async () => {
    const { api } = mockApis([{ ...employeeConfigured, department_ids: ["d1"] }]);
    api.listDepartments = vi.fn().mockResolvedValue([{ id: "d1", display_name: "研发部" }]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("employee-row")).toBeInTheDocument());
    expect(screen.getByText("研发部")).toBeInTheDocument();
  });

  it("模型没有显示名时回退显示 model_id", async () => {
    const unnamedProvider = { ...provider, supported_models: [{ model: "minimax-m3", display_name: "", enabled: true }] };
    mockApis([{ ...employeeConfigured, model_policy: { ...employeeConfigured.model_policy, model: "minimax-m3" } }], [unnamedProvider]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("employee-row")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("edit-config"));
    await waitFor(() => expect(screen.getByTestId("model-select")).toHaveTextContent("minimax-m3"));
  });

  it("配置状态：已配置显示「已配置」，未配置显示「待配置」", async () => {
    mockApis([employeeConfigured, employeeUnconfigured]);
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("config-status")).toHaveLength(2));
    const statuses = screen.getAllByTestId("config-status");
    expect(statuses[0]).toHaveTextContent("已配置");
    expect(statuses[1]).toHaveTextContent("待配置");
  });

  it("生命周期：已配置草稿可激活，未配置草稿保持禁用", async () => {
    const draftConfigured = { ...employeeConfigured, status: "draft" };
    const { api } = mockApis([draftConfigured, employeeUnconfigured]);
    (api.transitionEmployee as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...draftConfigured, status: "active" });
    renderPage();
    const buttons = await screen.findAllByRole("button", { name: "激活" });
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeDisabled();
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(api.transitionEmployee).toHaveBeenCalledWith("emp-1", "activate"));
  });

  it("编辑：点击编辑配置打开抽屉，修改模型后自动反推 provider 并保存", async () => {
    const { api, updateEmployee } = mockApis([{ ...employeeConfigured, role_title: "研究分析师", department_ids: ["d1", "d2"] }]);
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("employee-row")).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId("edit-config")[0]!);

    expect(await screen.findByRole("dialog", { name: "专家实例详情" })).toBeInTheDocument();
    expect(screen.queryByTestId("provider-select")).not.toBeInTheDocument();
    const modelSelect = screen.getByTestId("model-select");
    fireEvent.click(within(modelSelect).getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: /GPT-4o mini/, hidden: true }));

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledTimes(1));
    const callArgs = updateEmployee.mock.calls[0] as [string, EmployeeConfig];
    const [calledId, calledCfg] = callArgs;
    expect(calledId).toBe("emp-1");
    // 注入 employee 后抽屉直接使用，列表不会被二次拉取。
    expect(api.listEmployees).toHaveBeenCalledTimes(1);
    expect(calledCfg.model_policy.model).toBe("gpt-4o-mini");
    expect(calledCfg.model_policy.provider_ref).toBe("openai-main");
    // toEmployeeConfigIn: 服务端托管字段不回写
    expect((calledCfg as unknown as Record<string, unknown>).employee_id).toBeUndefined();
    expect((calledCfg as unknown as Record<string, unknown>).version).toBeUndefined();
    // 未编辑字段保留
    expect(calledCfg.tools).toEqual(["t1"]);
    expect(calledCfg.skills).toEqual(["s1"]);
    expect(calledCfg.knowledge_refs).toEqual(["k1"]);
    expect(calledCfg.persona).toBe("技术架构专家");
    expect(calledCfg.role_title).toBe("研究分析师");
    expect(calledCfg.department_ids).toEqual(["d1", "d2"]);
  });

  it("选择模型后自动反推其 provider", async () => {
    const { updateEmployee } = mockApis([employeeConfigured], [provider, providerB]);
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("employee-row")).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId("edit-config")[0]!);
    const modelSelect = await screen.findByTestId("model-select");
    fireEvent.click(within(modelSelect).getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: /Claude 3.5 Sonnet/, hidden: true }));
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(updateEmployee).toHaveBeenCalledTimes(1));
    expect(updateEmployee.mock.calls[0]![1].model_policy.provider_ref).toBe("anthropic-main");
  });

  it("按模型能力展示思考等级，而不是固定 basic/deep", async () => {
    const minimaxProvider = { ...provider, supported_models: [{ model: "minimax-m3", display_name: "MiniMax M3", enabled: true }] };
    mockApis([{ ...employeeConfigured, model_policy: { ...employeeConfigured.model_policy, model: "minimax-m3", provider_ref: "openai-main", thinking_level: null } }], [minimaxProvider]);
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("employee-row")).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId("edit-config")[0]!);
    const thinking = await screen.findByRole("combobox", { name: "思考深度" });
    fireEvent.click(thinking);
    expect(screen.getByRole("option", { name: /开启思考/, hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /basic|deep/, hidden: true })).not.toBeInTheDocument();
  });

  it("兼容旧 deep 配置并映射为 high", async () => {
    mockApis([{ ...employeeConfigured, model_policy: { ...employeeConfigured.model_policy, thinking_level: "deep" } }]);
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("employee-row")).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId("edit-config")[0]!);
    const thinking = await screen.findByRole("combobox", { name: "思考深度" });
    expect(thinking).toHaveTextContent("high");
  });

  it("保留模型支持的标准 thinking 档位", async () => {
    mockApis([{ ...employeeConfigured, model_policy: { ...employeeConfigured.model_policy, thinking_level: "medium" } }]);
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("employee-row")).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId("edit-config")[0]!);
    const thinking = await screen.findByRole("combobox", { name: "思考深度" });
    expect(thinking).toHaveTextContent("medium");
  });

  it("模型目录暂未关联服务时阻止保存", async () => {
    const orphan = {
      ...employeeConfigured,
      model_policy: { ...employeeConfigured.model_policy, model: "orphan-model", provider_ref: null },
    };
    mockApis([orphan], []);
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("employee-row")).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId("edit-config")[0]!);
    await screen.findByTestId("model-select");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("模型尚未关联平台服务");
  });

  it("模型归属服务缺少展示信息时仍按模型保存", async () => {
    const { updateEmployee } = mockApis([employeeUnconfigured], []);
    (usePlatformModelsApi as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      list: vi.fn().mockResolvedValue({
        providers: [],
        models: [{
          model: { provider_id: "missing-provider", model_id: "orphan-model", display_name: "Orphan", status: "published", version: 1 },
          rate: { pricing_version: 1, pricing_status: "known", input_usd_per_million: "1", output_usd_per_million: "2", cache_read_usd_per_million: null, cache_write_usd_per_million: null, currency: "USD" },
        }],
      }),
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("employee-row")).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId("edit-config")[0]!);
    const modelSelect = await screen.findByTestId("model-select");
    fireEvent.click(within(modelSelect).getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: /orphan-model/, hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateEmployee).toHaveBeenCalledTimes(1));
    expect(updateEmployee.mock.calls[0]![1].model_policy.provider_ref).toBe("missing-provider");
  });

  it("切换到能力更窄的模型时清空不兼容的 thinking 档位", async () => {
    const minimaxProvider = { ...provider, supported_models: [{ model: "minimax-m3", display_name: "MiniMax M3", enabled: true }] };
    mockApis([employeeConfigured], [provider, minimaxProvider]);
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("employee-row")).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId("edit-config")[0]!);
    const modelSelect = await screen.findByTestId("model-select");
    fireEvent.click(within(modelSelect).getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: /minimax-m3/, hidden: true }));
    expect(screen.getByRole("combobox", { name: "思考深度" })).toHaveTextContent("关闭思考");
  });

  it("保存成功后关闭抽屉并刷新列表", async () => {
    mockApis([employeeConfigured]);
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("employee-row")).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId("edit-config")[0]!);
    await screen.findByTestId("model-select");
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() =>
      expect(screen.queryByTestId("model-select")).not.toBeInTheDocument(),
    );
  });

  it("取消配置：关闭 Dialog 且不提交修改", async () => {
    const { updateEmployee } = mockApis([employeeConfigured]);
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("employee-row")).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId("edit-config")[0]!);
    const dialog = await screen.findByRole("dialog", { name: "专家实例详情" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "专家实例详情" })).not.toBeInTheDocument());
    expect(updateEmployee).not.toHaveBeenCalled();
  });

  it("保存失败：显示错误并保留配置 Dialog", async () => {
    const { updateEmployee } = mockApis([employeeConfigured]);
    updateEmployee.mockRejectedValueOnce(new Error("boom"));
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("employee-row")).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId("edit-config")[0]!);
    await screen.findByRole("dialog", { name: "专家实例详情" });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("保存失败"));
    expect(screen.getByRole("dialog", { name: "专家实例详情" })).toBeInTheDocument();
  });

  it("空状态：无实例时显示空提示", async () => {
    mockApis([]);
    renderPage();
    await waitFor(() => expect(screen.getByText("暂无已招募专家")).toBeInTheDocument());
  });

  it("加载失败：listEmployees 报错显示错误信息", async () => {
    const api = mockApis([]).api;
    (api.listEmployees as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("加载失败"));
  });
});

describe("toEmployeeConfigIn", () => {
  it("剔除服务端托管字段", () => {
    const minimal = toEmployeeConfigIn(employeeConfigured);
    const keys = Object.keys(minimal);
    expect(keys).not.toContain("employee_id");
    expect(keys).not.toContain("employee_slug");
    expect(keys).not.toContain("version");
    expect(keys).not.toContain("status");
    expect(keys).not.toContain("archive_reason");
    expect(keys).not.toContain("archived_at");
    // 业务字段完整保留
    expect(minimal.display_name).toBe("架构师");
    expect(minimal.tools).toEqual(["t1"]);
    expect(minimal.model_policy.model).toBe("gpt-4o");
  });
});
