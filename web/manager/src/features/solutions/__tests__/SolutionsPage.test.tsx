import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { SolutionsPage } from "../SolutionsPage";
import { useExpertsApi } from "../../experts/useExpertsApi";
import { useGrantsApi } from "../../grants/useGrantsApi";

vi.mock("../../experts/useExpertsApi", () => ({ useExpertsApi: vi.fn() }));
vi.mock("../../grants/useGrantsApi", () => ({ useGrantsApi: vi.fn() }));
// 本企业技能目录：null 表示读取失败。不用 vi.fn，原因同 platformModelsApi。
let currentSkills: unknown[] | null = [];
const capabilityApi = { listSkills: async () => { if (currentSkills === null) throw new Error("forbidden"); return currentSkills; } };
vi.mock("../../capability/useCapabilityApi", () => ({ useCapabilityApi: () => capabilityApi }));
const platformModels = {
  providers: [],
  models: [{
    model: { provider_id: "p1", model_id: "m1", display_name: "m1", status: "published", version: 1 },
    rate: { pricing_status: "known", input_usd_per_million: "1", output_usd_per_million: "2" },
  }],
};
// 不用 vi.fn:afterEach 的 restoreAllMocks 会清掉它的实现。
let currentModels: typeof platformModels = platformModels;
let modelsError: Error | null = null;
const platformModelsApi = { list: async () => { if (modelsError) throw modelsError; return currentModels; } };
vi.mock("../../platform-models/usePlatformModelsApi", () => ({ usePlatformModelsApi: () => platformModelsApi }));
import type { ExpertsApi } from "../../experts/useExpertsApi";
import type { GrantsApi } from "../../grants/useGrantsApi";
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

function mockApi(grantsOverrides: Partial<GrantsApi> = {}): ExpertsApi {
  const grantsApi: GrantsApi = {
    listGrants: vi.fn().mockResolvedValue([]), createGrant: vi.fn(), updateGrant: vi.fn(), deleteGrant: vi.fn(),
    listMembers: vi.fn().mockResolvedValue([{ id: "m-1", display_name: "成员一" }]),
    listDepartments: vi.fn().mockResolvedValue([{ id: "d-1", display_name: "部门一" }]),
    listExperts: vi.fn().mockResolvedValue([]), listSolutions: vi.fn().mockResolvedValue([]),
    ...grantsOverrides,
  };
  (useGrantsApi as unknown as ReturnType<typeof vi.fn>).mockReturnValue(grantsApi);
  const api: ExpertsApi = {
    listTemplates: vi.fn().mockResolvedValue([]),
    listSolutions: vi.fn().mockResolvedValue([{
      solution_id: "sol-1", version: "1", display_name: "测试方案",
      experts: [{ template_id: "tpl-1", version: "1", display_name: "架构师", persona: "技术架构专家", category: "tech" }],
      coordinator_template_id: "tpl-1", coordinator_instructions: "先分析再汇总", tags: ["金融"],
    } as SolutionPackage]),
    recruitExpert: vi.fn().mockResolvedValue({}),
    applySolution: vi.fn().mockResolvedValue({}),
    listEmployees: vi.fn().mockResolvedValue([]),
    updateEmployee: vi.fn().mockResolvedValue(null),
    listSolutionInstances: vi.fn().mockResolvedValue([]),
    transitionEmployee: vi.fn().mockResolvedValue(null),
    getLifecycleOptions: vi.fn().mockResolvedValue({ actions: [] }),
    copyEmployee: vi.fn(),
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

async function applyDefaultSolution(): Promise<HTMLElement> {
  const cardButton = screen.getAllByRole("button", { name: "应用方案" })[0]!;
  fireEvent.click(cardButton);
  const dialog = await screen.findByRole("dialog", { name: "应用测试方案" });
  fireEvent.click(await within(dialog).findByRole("combobox", { name: /授权成员/ }));
  fireEvent.click(screen.getByRole("option", { name: "成员一", hidden: true }));
  fireEvent.click(within(dialog).getByRole("button", { name: "应用方案" }));
  return dialog;
}

const solutionInstance: SolutionInstance = {
  id: "si-1", solution_id: "sol-1", solution_version: "v1", display_name: "行业方案A", status: "active",
  expert_employee_ids: ["emp-1", "emp-2"], coordinator_employee_id: "emp-1", config_version: 1,
  created_at: null, updated_at: null,
};

describe("SolutionsPage", () => {
  beforeEach(() => { localStorage.clear(); currentModels = platformModels; modelsError = null; });
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it("浏览：渲染可应用方案", async () => {
    mockApi(); renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 1, name: "方案目录" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "测试方案" })).toBeInTheDocument();
  });

  it("应用方案：选择授权成员后提交 solution_id + member_ids", async () => {
    let finishMembers!: (members: { id: string; display_name: string }[]) => void;
    const pendingMembers = new Promise<{ id: string; display_name: string }[]>((resolve) => { finishMembers = resolve; });
    const api = mockApi({ listMembers: vi.fn().mockReturnValue(pendingMembers) }); renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    const applying = applyDefaultSolution().then(() => undefined, (error: unknown) => error);
    const dialog = await screen.findByRole("dialog", { name: "应用测试方案" });
    expect(within(dialog).queryByRole("combobox", { name: /授权成员/ })).not.toBeInTheDocument();
    finishMembers([{ id: "m-1", display_name: "成员一" }]);
    expect(await applying).toBeUndefined();
    await waitFor(() => expect(api.applySolution).toHaveBeenCalledWith({ solution_id: "sol-1", solution_version: "1", expert_models: { "tpl-1": { provider_ref: "p1", model: "m1" } }, member_ids: ["m-1"], department_ids: [] }));
  });

  it("部门设置允许显式选择未设置并在无授权目标时应用", async () => {
    const api = mockApi(); renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "应用方案" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "应用测试方案" });
    fireEvent.click(await within(dialog).findByRole("combobox", { name: /所属部门/ }));
    expect(screen.getByRole("option", { name: "未设置", hidden: true })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "应用方案" }));
    await waitFor(() => expect(api.applySolution).toHaveBeenCalledWith({ solution_id: "sol-1", solution_version: "1", expert_models: { "tpl-1": { provider_ref: "p1", model: "m1" } }, member_ids: [], department_ids: [] }));
  });

  it("没有可用模型：应用方案按钮禁用并提示", async () => {
    mockApi();
    currentModels = { providers: [], models: [] };
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "应用方案" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "应用测试方案" });
    await waitFor(() => expect(within(dialog).getByText("暂无可用模型，请联系平台运营开通")).toBeInTheDocument());
    expect(within(dialog).getByRole("button", { name: "应用方案" })).toBeDisabled();
  });

  it("多个新建专家：「全部使用」一次选同一模型；422 标红后改选该专家的模型即清除提示", async () => {
    const api = mockApi();
    (api.listSolutions as ReturnType<typeof vi.fn>).mockResolvedValue([{
      solution_id: "sol-1", version: "1", display_name: "测试方案",
      experts: [
        { template_id: "tpl-1", version: "1", display_name: "架构师", persona: "p", category: "tech" },
        { template_id: "tpl-2", version: "1", display_name: "测试员", persona: "p", category: "tech" },
      ],
      coordinator_template_id: "tpl-1",
    } as SolutionPackage]);
    currentModels = {
      providers: [],
      models: ["m1", "m2"].map((id) => ({
        model: { provider_id: "p1", model_id: id, display_name: id, status: "published", version: 1 },
        rate: { pricing_status: "known", input_usd_per_million: "1", output_usd_per_million: "2" },
      })),
    };
    (api.applySolution as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new ApiError("1 expert(s) have no usable model", 422, "model_unavailable", {
        type: "x", title: "t", status: 422, code: "model_unavailable",
        errors: [{ loc: ["body", "expert_models", "tpl-2"], message: "m", type: "model_unavailable" }],
      }))
      .mockResolvedValueOnce({});
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "应用方案" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "应用测试方案" });
    const submit = within(dialog).getByRole("button", { name: "应用方案" });
    const pick = async (testId: string, option: string) => {
      const picker = await within(dialog).findByTestId(testId);
      await waitFor(() => expect(within(picker).getByRole("combobox")).toBeEnabled());
      const combobox = within(picker).getByRole("combobox");
      fireEvent.click(combobox);
      // 三个下拉的选项都在文档里，只在当前下拉控制的列表中找。
      const listbox = document.getElementById(combobox.getAttribute("aria-controls") ?? "");
      expect(listbox).not.toBeNull();
      fireEvent.click(within(listbox as HTMLElement).getByRole("option", { name: option, hidden: true }));
    };

    expect(submit).toBeDisabled(); // 两个模型可选，不自动选中
    await pick("solution-model-all", "m2");
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(within(dialog).getByText("该模型不可用，请换一个")).toBeInTheDocument());
    expect(api.applySolution).toHaveBeenLastCalledWith(expect.objectContaining({
      expert_models: { "tpl-1": { provider_ref: "p1", model: "m2" }, "tpl-2": { provider_ref: "p1", model: "m2" } },
    }));

    await pick("solution-model-tpl-2", "m1");
    await waitFor(() => expect(within(dialog).queryByText("该模型不可用，请换一个")).not.toBeInTheDocument());
    fireEvent.click(submit);
    await waitFor(() => expect(api.applySolution).toHaveBeenLastCalledWith(expect.objectContaining({
      expert_models: { "tpl-1": { provider_ref: "p1", model: "m2" }, "tpl-2": { provider_ref: "p1", model: "m1" } },
    })));
  });

  it("模型列表加载失败：弹窗显示原因，不能应用", async () => {
    mockApi();
    modelsError = new Error("模型目录暂不可用");
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "应用方案" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "应用测试方案" });
    expect(await within(dialog).findByText("模型目录暂不可用")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "应用方案" })).toBeDisabled();
  });

  it("422 整单失败：在对应专家的模型下拉旁标出原因，弹窗保持打开", async () => {
    const api = mockApi();
    (api.applySolution as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(
      "1 expert(s) have no usable model", 422, "model_unavailable",
      {
        type: "x", title: "t", status: 422, code: "model_unavailable",
        errors: [{ loc: ["body", "expert_models", "tpl-1"], message: "m", type: "model_unavailable" }],
      },
    ));
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "应用方案" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "应用测试方案" });
    const submit = within(dialog).getByRole("button", { name: "应用方案" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(within(dialog).getByText("该模型不可用，请换一个")).toBeInTheDocument());
    expect(within(dialog).getByText("有专家的模型不可用，请调整后重试")).toBeInTheDocument();
  });

  it("只读成员不显示应用入口", async () => {
    mockApi(); renderPage(["member"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    expect(screen.queryByText("应用方案")).not.toBeInTheDocument();
  });

  it("查看方案详情：点击查看详情打开抽屉展示专家/协调说明", async () => {
    mockApi(); renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    fireEvent.click(screen.getByText("查看详情"));
    const dialog = await screen.findByRole("dialog", { name: "测试方案" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("架构师")).toBeInTheDocument();
    expect(within(dialog).getByText("群主")).toBeInTheDocument();
    expect(screen.getByText("先分析再汇总")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
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
    await waitFor(() => expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("加载失败"))).toBe(true));
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
    await applyDefaultSolution();
    await waitFor(() => expect(screen.getByText("nope")).toBeInTheDocument());
  });

  it("应用方案成功：显示成功提示", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    await applyDefaultSolution();
    await waitFor(() => expect(screen.getByText("方案已应用")).toBeInTheDocument());
  });

  const inactiveInstance: SolutionInstance = {
    ...solutionInstance, id: "si-2", status: "inactive",
    expert_employee_ids: [],
  };

  it("非 active 状态：实例卡显示非高亮状态标签", async () => {
    const api = mockApi();
    (api.listSolutionInstances as ReturnType<typeof vi.fn>).mockResolvedValue([inactiveInstance]);
    renderPage(["owner"]);
    const card = await screen.findByTestId("solution-instance-card");
    expect(within(card).getByText("inactive")).toBeInTheDocument();
  });


  it("应用方案成功：显示前往专家实例配置入口", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试方案")).toBeInTheDocument());
    await applyDefaultSolution();
    await waitFor(() => expect(screen.getByTestId("goto-experts")).toBeInTheDocument());
    expect(screen.getByTestId("goto-experts")).toHaveAttribute("href", "/experts");
  });

  describe("方案概览（设计 §3.4 / §3.7）", () => {
    const group = {
      solution_id: "sol-g", version: "2", display_name: "质检组群", mode: "group",
      experts: [
        { template_id: "tpl-a", version: "1", display_name: "质检协调" },
        { template_id: "tpl-b", version: "1", display_name: "检验员" },
      ],
      coordinator_template_id: "tpl-a",
      orchestration_rules: "1. @{tpl-a} 先拆解\n2. @{tpl-b} 执行检验",
      recommended_capabilities: [
        { kind: "skill", ref: "ps-1", display_name: "读表", purpose: "读取 Excel" },
        { kind: "skill", ref: "ps-2", purpose: "写报告" },
        { kind: "mcp", ref: "mes", display_name: "MES", purpose: "读工单" },
      ],
    } as SolutionPackage;
    const installed = [{ catalog_id: "c1", skill_id: "tenant-sheet", display_name: "读表", version: "1", install_policy: "on_demand", binding_policy: "opt_in", visibility: "tenant", config: { source_skill_id: "ps-1" }, catalog_version: 1 }];

    afterEach(() => { currentSkills = []; });

    it("目录卡片显示类型、成员数、群主与缺失的 skill 数", async () => {
      currentSkills = installed;
      const api = mockApi();
      (api.listSolutions as ReturnType<typeof vi.fn>).mockResolvedValue([group]);
      renderPage(["owner"]);
      const card = await screen.findByRole("article", { name: "质检组群" });
      expect(within(card).getByText("组群方案")).toBeInTheDocument();
      expect(within(card).getByTestId("solution-summary").textContent).toBe("2 位专家 · 群主 质检协调 · 推荐能力 3 项（1 项 skill 企业缺失）");
    });

    it("应用弹窗按 成员/群主 → 规则 → 能力清单 → 模型 排列，并标注 skill 状态与 MCP 需本机安装", async () => {
      currentSkills = installed;
      const api = mockApi();
      (api.listSolutions as ReturnType<typeof vi.fn>).mockResolvedValue([group]);
      renderPage(["owner"]);
      await screen.findByRole("article", { name: "质检组群" });
      fireEvent.click(screen.getAllByRole("button", { name: "应用方案" })[0]!);
      const dialog = await screen.findByRole("dialog", { name: "应用质检组群" });
      const overview = within(dialog).getByTestId("solution-overview");
      expect(within(overview).getByTestId("solution-overview-members").textContent).toContain("质检协调群主");
      expect(within(overview).getByTestId("solution-overview-rules").textContent).toBe("1. @质检协调 先拆解\n2. @检验员 执行检验");
      const rows = within(overview).getAllByTestId("solution-capability").map((row) => row.textContent);
      expect(rows[0]).toContain("企业已具备");
      expect(rows[1]).toContain("企业缺失");
      expect(rows[2]).toContain("成员需在本机安装");
      // 概览在模型选择之前。
      const models = await within(dialog).findByTestId("solution-expert-models");
      expect(overview.compareDocumentPosition(models) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("技能目录读不到时 skill 显示「无法确认」，方案仍可浏览", async () => {
      currentSkills = null;
      const api = mockApi();
      (api.listSolutions as ReturnType<typeof vi.fn>).mockResolvedValue([group]);
      renderPage(["owner"]);
      await screen.findByRole("article", { name: "质检组群" });
      fireEvent.click(screen.getByText("查看详情"));
      const dialog = await screen.findByRole("dialog", { name: "质检组群" });
      const rows = within(dialog).getAllByTestId("solution-capability").map((row) => row.textContent);
      expect(rows.slice(0, 2).every((text) => text?.includes("无法确认"))).toBe(true);
      // 技能目录读取失败不算页面错误：没有带文字的错误提示（组件库的空播报区不算）。
      expect(screen.queryAllByRole("alert").filter((el) => el.textContent?.trim())).toEqual([]);
      expect(screen.queryByText("forbidden")).not.toBeInTheDocument();
    });

    it("单人方案：不显示群主与编排规则，说明私聊使用", async () => {
      const api = mockApi();
      (api.listSolutions as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...group, mode: "solo", experts: group.experts!.slice(0, 1), orchestration_rules: "", recommended_capabilities: [] }]);
      renderPage(["owner"]);
      const card = await screen.findByRole("article", { name: "质检组群" });
      expect(within(card).getByText("单人方案")).toBeInTheDocument();
      expect(within(card).getByTestId("solution-summary").textContent).toBe("1 位专家 · 私聊使用");
      fireEvent.click(screen.getByText("查看详情"));
      const dialog = await screen.findByRole("dialog", { name: "质检组群" });
      expect(within(dialog).queryByText("群主")).not.toBeInTheDocument();
      expect(within(dialog).queryByText("群聊编排规则")).not.toBeInTheDocument();
      expect(within(dialog).getByText(/不建群/)).toBeInTheDocument();
    });
  });
});
