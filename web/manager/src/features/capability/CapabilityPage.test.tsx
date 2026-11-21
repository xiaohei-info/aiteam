import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { I18nContext } from "../../i18n/context";
import { managerMessages } from "../../i18n/messages";
import { CapabilityPage } from "./CapabilityPage";
import { useCapabilityApi, type CapabilityApi } from "./useCapabilityApi";
import type { ConnectorCatalog, MemoryPolicyCatalog, SkillCatalog } from "./types";

vi.mock("./useCapabilityApi", () => ({ useCapabilityApi: vi.fn() }));
const modelsApi = { list: async () => ({ providers: [], models: [] }) };
vi.mock("../platform-models/usePlatformModelsApi", () => ({ usePlatformModelsApi: () => modelsApi }));
const marketApi = { list: vi.fn(async () => [] as unknown[]), install: vi.fn(async () => ({})) };
vi.mock("../skill-market/useSkillMarketApi", () => ({ useSkillMarketApi: () => marketApi }));
vi.mock("../../shell/useMe", () => ({ useMe: () => ({ me: { enterprise_name: "太一科技", enterprise_code: "e2e" }, blocked: null }) }));

const skill: SkillCatalog = {
  catalog_id: "skill-c1", skill_id: "skill-a", display_name: "技能 A", version: "1",
  install_policy: "on_demand", binding_policy: "opt_in", visibility: "tenant",
  config: {}, catalog_version: 1, package_status: "ready",
  files: [{ path: "SKILL.md", content: "---\nname: skill-a\ndescription: 技能 A 的说明。写周报时使用。\n---\n# A\n" }, { path: "scripts/a.sh", content: "echo a\n" }],
};
const connector: ConnectorCatalog = {
  catalog_id: "connector-c1", connector_id: "connector-a", display_name: "连接器 A",
  grant_scope: "tenant_wide", visibility: "tenant", config: {}, catalog_version: 1,
};
const memory: MemoryPolicyCatalog = {
  catalog_id: "memory-c1", policy_id: "memory-a", display_name: "记忆策略 A",
  retention_days: 30, visibility: "private", policy: {}, seed_memories: [], config: {}, catalog_version: 1,
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

/** 「新增技能」是菜单：导入技能 / 让模型帮我找 / 从零写一个。 */
async function openNewSkillEditor() {
  fireEvent.click(screen.getByRole("button", { name: "新增技能" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "从零写一个" }));
  return screen.findByRole("dialog", { name: "从零写一个技能" });
}

const saved = { origin: { kind: "editor", label: "在线编辑" }, results: [{ root: "", name: "skill-b", version: "abc", status: "installed" }] };

function mockApi(overrides: Partial<CapabilityApi> = {}): CapabilityApi {
  const api: CapabilityApi = {
    listSkills: vi.fn().mockResolvedValue([skill]),
    listConnectors: vi.fn().mockResolvedValue([connector]),
    listMemoryPolicies: vi.fn().mockResolvedValue([memory]),
    createSkill: vi.fn().mockResolvedValue(skill),
    updateSkill: vi.fn().mockResolvedValue(skill),
    deleteSkill: vi.fn().mockResolvedValue(undefined),
    createConnector: vi.fn().mockResolvedValue(connector),
    updateConnector: vi.fn().mockResolvedValue(connector),
    deleteConnector: vi.fn().mockResolvedValue(undefined),
    createMemoryPolicy: vi.fn().mockResolvedValue(memory),
    updateMemoryPolicy: vi.fn().mockResolvedValue(memory),
    deleteMemoryPolicy: vi.fn().mockResolvedValue(undefined),
    updateSkillSettings: vi.fn().mockResolvedValue(skill),
    previewSkillImport: vi.fn().mockResolvedValue(null),
    importSkills: vi.fn().mockResolvedValue(saved),
    ...overrides,
  };
  (useCapabilityApi as unknown as ReturnType<typeof vi.fn>).mockReturnValue(api);
  return api;
}

function renderPage(roles: string[] = ["owner"], state?: unknown) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue(roles)}>
        <MemoryRouter initialEntries={[{ pathname: "/capability", state }]}><CapabilityPage /></MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("CapabilityPage", () => {
  it("展示三类能力目录的命名表格", async () => {
    mockApi();
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "能力目录" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "技能目录" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "连接器目录" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "记忆策略目录" })).toBeInTheDocument();
  });

  it("只读成员不显示新增、编辑和删除操作", async () => {
    mockApi();
    renderPage(["member"]);
    await screen.findByText("技能 A");
    expect(screen.queryByRole("button", { name: "新增技能" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
  });

  it("技能表按技能本身展示：说明取自 SKILL.md、成员自装、状态；没有安装 / 绑定策略列", async () => {
    mockApi({ listSkills: vi.fn().mockResolvedValue([skill, { ...skill, catalog_id: "c2", display_name: "技能 B", visibility: "private", binding_policy: "disabled" }]) });
    renderPage();
    const table = await screen.findByRole("table", { name: "技能目录" });
    expect(within(table).getAllByText("技能 A 的说明。写周报时使用。")).toHaveLength(2);
    expect(within(table).getByText("可以")).toBeInTheDocument();
    expect(within(table).getByText("仅配给专家")).toBeInTheDocument();
    expect(within(table).getByText("已停用")).toBeInTheDocument();
    for (const gone of ["安装策略", "绑定策略", "可见性", "执行包"]) expect(within(table).queryByText(gone)).toBeNull();
  });

  it("从零写一个：按 SKILL.md 填名称、说明、指令，存为在线编辑来源并带上两项设置", async () => {
    const api = mockApi();
    renderPage();
    await screen.findByText("技能 A");
    const dialog = within(await openNewSkillEditor());
    for (const gone of [/安装策略/, /绑定策略/, /JSON/]) expect(dialog.queryByText(gone)).toBeNull();
    fireEvent.change(dialog.getByRole("textbox", { name: /^名称/ }), { target: { value: "skill-b" } });
    fireEvent.change(dialog.getByRole("textbox", { name: /^说明/ }), { target: { value: "整理会议纪要。开完会要出纪要时使用。" } });
    fireEvent.click(dialog.getByRole("checkbox", { name: /成员可以自己安装/ }));
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.importSkills).toHaveBeenCalledTimes(1));
    const input = vi.mocked(api.importSkills).mock.calls[0]![0];
    expect(input).toMatchObject({ source: "editor", visibility: "private", binding_policy: "opt_in" });
    expect(input.files!.map((item) => item.path)).toEqual(["SKILL.md"]);
    expect(await screen.findByText("已新建技能 skill-b")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "从零写一个技能" })).toBeNull();
  });

  it("从零写一个：与已有技能重名时提示，不覆盖；保存失败留在弹窗里", async () => {
    const api = mockApi({ importSkills: vi.fn().mockResolvedValue({ ...saved, results: [{ ...saved.results[0], status: "failed", reason: "技能包不符合规则" }] }) });
    renderPage();
    await screen.findByText("技能 A");
    const dialog = within(await openNewSkillEditor());
    fireEvent.change(dialog.getByRole("textbox", { name: /^名称/ }), { target: { value: "skill-a" } });
    fireEvent.change(dialog.getByRole("textbox", { name: /^说明/ }), { target: { value: "说明" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    expect(await dialog.findByText(/企业技能里已有「skill-a」/)).toBeInTheDocument();
    expect(api.importSkills).not.toHaveBeenCalled();
    fireEvent.change(dialog.getByRole("textbox", { name: /^名称/ }), { target: { value: "skill-c" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    expect(await dialog.findByText("技能包不符合规则")).toBeInTheDocument();
  });

  it("编辑技能：名称锁定；只改设置时只调 updateSkillSettings，不存新版本", async () => {
    const api = mockApi();
    renderPage();
    await screen.findByText("技能 A");
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    const dialog = within(await screen.findByRole("dialog", { name: "编辑技能 技能 A" }));
    expect(dialog.getByRole("textbox", { name: /^名称/ })).toBeDisabled();
    expect(dialog.getByRole("textbox", { name: "指令" })).toHaveValue("# A\n");
    expect(dialog.getByText("scripts/a.sh · 7 B")).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("checkbox", { name: /停用/ }));
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.updateSkillSettings).toHaveBeenCalledWith("skill-c1", { skill_id: "skill-a", visibility: "tenant", binding_policy: "disabled" }));
    expect(api.importSkills).not.toHaveBeenCalled();
    expect(await screen.findByText("已更新 技能 A 的设置")).toBeInTheDocument();
  });

  it("编辑技能内容：附带文件照带，存为新版本", async () => {
    const api = mockApi();
    renderPage();
    await screen.findByText("技能 A");
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    const dialog = within(await screen.findByRole("dialog", { name: "编辑技能 技能 A" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "指令" }), { target: { value: "# A 改过\n" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.importSkills).toHaveBeenCalledTimes(1));
    const input = vi.mocked(api.importSkills).mock.calls[0]![0];
    expect(input.source).toBe("editor");
    expect(input.files!.map((item) => item.path)).toEqual(["SKILL.md", "scripts/a.sh"]);
    expect(input).not.toHaveProperty("visibility");  // 升级保留原设置
    expect(api.updateSkillSettings).not.toHaveBeenCalled();
  });

  const platformSkill: SkillCatalog = {
    ...skill, catalog_id: "skill-p1", skill_id: "platform-p1", display_name: "weather", version: "1.0.0", namespace: "taiyim",
    config: { source: "operator", source_skill_id: "p1", skill_name: "weather" },
    files: [{ path: "SKILL.md", content: "---\nname: weather\ndescription: 查天气。出门前用。\n---\n# W\n" }],
  };

  it("平台技能：显示 taiyim/ 前缀；只改设置作用于原件", async () => {
    const api = mockApi({ listSkills: vi.fn().mockResolvedValue([platformSkill]) });
    renderPage();
    const table = await screen.findByRole("table", { name: "技能目录" });
    await within(table).findByText("taiyim/weather");
    fireEvent.click(within(table).getByRole("button", { name: "编辑" }));
    const dialog = within(await screen.findByRole("dialog", { name: "编辑技能 taiyim/weather" }));
    expect(dialog.getByText(/「太一科技\/名称」这个副本，平台原件保留/)).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("checkbox", { name: /成员可以自己安装/ }));
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.updateSkillSettings).toHaveBeenCalledWith("skill-p1", { skill_id: "platform-p1", visibility: "private", binding_policy: "opt_in" }));
    expect(api.importSkills).not.toHaveBeenCalled();
  });

  it("平台技能也能删除：确认文案说明只是移出企业列表，可重新添加", async () => {
    const api = mockApi({ listSkills: vi.fn().mockResolvedValue([platformSkill]) });
    renderPage();
    const table = await screen.findByRole("table", { name: "技能目录" });
    await within(table).findByText("taiyim/weather");
    fireEvent.click(within(table).getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("alertdialog", { name: /删除 taiyim\/weather/ });
    expect(within(dialog).getByText(/平台上的原技能不受影响，可在「新增技能 → 添加平台技能」重新添加/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.deleteSkill).toHaveBeenCalledWith("skill-p1"));
  });

  it("编辑平台技能的内容：另存为企业副本（fork_of），不动原件；与企业技能重名时拦下", async () => {
    const api = mockApi({ listSkills: vi.fn().mockResolvedValue([platformSkill, { ...skill, skill_id: "weather-taiyi", display_name: "weather-taiyi" }]) });
    renderPage();
    const table = await screen.findByRole("table", { name: "技能目录" });
    fireEvent.click((await within(table).findAllByRole("button", { name: "编辑" }))[0]!);
    const dialog = within(await screen.findByRole("dialog", { name: "编辑技能 taiyim/weather" }));
    const name = dialog.getByRole("textbox", { name: /^名称/ });
    expect(name).not.toBeDisabled();
    fireEvent.change(dialog.getByRole("textbox", { name: /^说明/ }), { target: { value: "查天气，带穿衣建议。出门前用。" } });
    fireEvent.change(name, { target: { value: "weather-taiyi" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    expect(await dialog.findByText(/企业技能里已有「weather-taiyi」/)).toBeInTheDocument();
    fireEvent.change(name, { target: { value: "weather" } });
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.importSkills).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.importSkills).mock.calls[0]![0]).toMatchObject({ source: "editor", fork_of: "skill-p1", visibility: "tenant", binding_policy: "opt_in" });
    expect(api.updateSkillSettings).not.toHaveBeenCalled();
    expect(await screen.findByText("已另存为企业技能 太一科技/weather，平台原件保留")).toBeInTheDocument();
  });

  it("平台有新版本：行内提示「平台有新版本」，更新入口在列表右上角「全部更新（N）」", async () => {
    const item = { skill_id: "p1", owner: "platform", slug: "weather", display_name: "weather", summary: "", status: "published",
      published_version: "2.0.0", content_hash: "h2", installed: true, update_available: true };
    marketApi.list.mockResolvedValueOnce([item]);
    mockApi({ listSkills: vi.fn().mockResolvedValue([platformSkill]) });
    renderPage();
    const table = await screen.findByRole("table", { name: "技能目录" });
    await within(table).findByText("平台有新版本");
    expect(within(table).getByText("v2.0.0")).toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: "更新" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "全部更新（1）" }));
    await waitFor(() => expect(marketApi.install).toHaveBeenCalledWith(item));
    expect(await screen.findByText(/已把 taiyim\/weather 更新到 v2.0.0/)).toBeInTheDocument();
  });

  it("全部更新：逐个原地更新；某个失败时停下并说明已更新几项、哪个失败", async () => {
    const second: SkillCatalog = { ...platformSkill, catalog_id: "skill-p2", skill_id: "platform-p2", display_name: "notes", config: { source: "operator", source_skill_id: "p2", skill_name: "notes" } };
    const items = [
      { skill_id: "p1", owner: "platform", slug: "weather", display_name: "weather", summary: "", status: "published", published_version: "2.0.0", content_hash: "h2", installed: true, update_available: true },
      { skill_id: "p2", owner: "platform", slug: "notes", display_name: "notes", summary: "", status: "published", published_version: "3.0.0", content_hash: "h3", installed: true, update_available: true },
    ];
    marketApi.list.mockResolvedValue(items);
    marketApi.install.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("平台暂时不可达"));
    mockApi({ listSkills: vi.fn().mockResolvedValue([platformSkill, second]) });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "全部更新（2）" }));
    expect(await screen.findByText("已更新 1 项；taiyim/notes 更新失败：平台暂时不可达")).toBeInTheDocument();
    expect(marketApi.install).toHaveBeenCalledTimes(2);
    marketApi.list.mockResolvedValue([]);
  });

  it("删除技能：经 AlertDialog 确认后调用 deleteSkill", async () => {
    const api = mockApi();
    renderPage();
    await screen.findByText("技能 A");
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]!);
    const dialog = screen.getByRole("alertdialog", { name: /删除 技能 A/ });
    expect(dialog).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.deleteSkill).toHaveBeenCalledWith("skill-c1"));
  });
});

describe("导入技能", () => {
  const item = (root: string, name: string, extra: Record<string, unknown> = {}) => ({
    root, ok: true, name, description: `${name} 的说明`, version: "1.0.0", file_count: 2, total_bytes: 300,
    files: [{ path: "SKILL.md", size: 200 }, { path: "scripts/run.sh", size: 100 }], skipped: [], existing: "none", ...extra,
  });

  async function openImport() {
    fireEvent.click(await screen.findByRole("button", { name: "新增技能" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "导入技能" }));
    return screen.findByRole("dialog", { name: "导入技能" });
  }

  it("表格显示来源列", async () => {
    mockApi({ listSkills: vi.fn().mockResolvedValue([{ ...skill, config: { source: "clawhub" } }, { ...skill, catalog_id: "c2", config: { source: "operator" } }]) });
    renderPage();
    expect(await screen.findByText("ClawHub")).toBeInTheDocument();
    expect(screen.getByText("平台市场")).toBeInTheDocument();
  });

  it("粘贴 SKILL.md：检查 → 预览 → 导入，结果分组显示并刷新目录", async () => {
    const api = mockApi({
      previewSkillImport: vi.fn().mockResolvedValue({ origin: { kind: "text", label: "粘贴" }, preview: item("", "weekly-report", { skipped: [{ path: "hooks/openclaw/h.js", reason: "platform_hook" }] }) }),
      importSkills: vi.fn().mockResolvedValue({ origin: { kind: "text", label: "粘贴" }, results: [{ root: "", name: "weekly-report", version: "1.0.0", status: "installed" }] }),
    });
    renderPage();
    await openImport();
    fireEvent.click(screen.getByRole("button", { name: "粘贴 SKILL.md" }));
    fireEvent.change(screen.getByLabelText(/SKILL.md 内容/), { target: { value: "---\nname: weekly-report\n---" } });
    expect(screen.getByRole("button", { name: "导入" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "检查" }));
    expect(await screen.findByText("weekly-report · v1.0.0")).toBeInTheDocument();
    expect(screen.getByText("新增")).toBeInTheDocument();
    expect(screen.getByText("hooks/openclaw/h.js")).toBeInTheDocument();
    expect(screen.getByText("其他平台专用钩子")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    await waitFor(() => expect(api.importSkills).toHaveBeenCalledWith(expect.objectContaining({ source: "text", roots: [""], visibility: "tenant" })));
    expect(await screen.findByText("已新增 1 个")).toBeInTheDocument();
    expect(api.listSkills).toHaveBeenCalledTimes(2);
  });

  it("包里多个技能：只导入勾选的，不能导入的标出原因，同内容的不可选", async () => {
    const api = mockApi({
      previewSkillImport: vi.fn().mockResolvedValue({ origin: { kind: "url", label: "u" }, scan: [
        item("a", "alpha"), item("b", "beta", { existing: "update", existing_version: "0.9.0" }), item("c", "gamma", { existing: "same" }),
        { ...item("d", ""), ok: false, reason: "SKILL.md 缺少 name" },
      ] }),
      importSkills: vi.fn().mockResolvedValue({ origin: { kind: "url", label: "u" }, results: [{ root: "b", name: "beta", version: "1.0.0", status: "updated" }] }),
    });
    renderPage();
    await openImport();
    fireEvent.click(screen.getByRole("button", { name: "网址" }));
    fireEvent.change(screen.getByLabelText(/^网址/), { target: { value: "https://github.com/a/b" } });
    fireEvent.click(screen.getByRole("button", { name: "检查" }));
    expect(await screen.findByText("将升级 v0.9.0 → v1.0.0")).toBeInTheDocument();
    expect(screen.getByText("SKILL.md 缺少 name")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /gamma/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导入 2 个" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    await waitFor(() => expect(api.importSkills).toHaveBeenCalledWith(expect.objectContaining({ roots: ["b"] })));
    expect(await screen.findByText("已升级新版本 1 个")).toBeInTheDocument();
  });

  it("ClawHub 同名多作者：选作者后再检查，显示两个扫描器结论与风险提示", async () => {
    const preview = vi.fn()
      .mockResolvedValueOnce({ origin: { kind: "clawhub", label: "ClawHub" }, clawhub: { candidates: [{ owner: "a", slug: "x", url: "https://clawhub.ai/a/skills/x" }, { owner: "b", slug: "x", url: "https://clawhub.ai/b/skills/x" }] } })
      .mockResolvedValueOnce({ origin: { kind: "clawhub", label: "ClawHub" }, preview: item("", "x"), clawhub: { candidates: null, security: { status: "clean", has_warnings: true, scanners: [{ name: "skillspector", status: "suspicious" }, { name: "llm", status: "clean" }] } } });
    mockApi({ previewSkillImport: preview });
    renderPage();
    await openImport();
    fireEvent.click(screen.getByRole("button", { name: "ClawHub" }));
    fireEvent.change(screen.getByLabelText(/ClawHub 地址/), { target: { value: "https://clawhub.ai/skills/x" } });
    fireEvent.click(screen.getByRole("button", { name: "检查" }));
    fireEvent.click(await screen.findByRole("button", { name: "b/x" }));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith({ source: "clawhub", url: "https://clawhub.ai/b/skills/x" }));
    expect(await screen.findByText("静态扫描：有可疑项")).toBeInTheDocument();
    expect(screen.getByText("模型复核：未发现风险")).toBeInTheDocument();
    expect(screen.getByText("扫描提示有风险，仅供参考")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入" })).toBeEnabled();
  });

  it("检查失败显示原因，弹窗保留", async () => {
    const { ApiError } = await import("@aiteam/shared");
    mockApi({ previewSkillImport: vi.fn().mockRejectedValue(new ApiError("地址指向内网、本机或保留网段，不允许访问", 422, "validation_error")) });
    renderPage();
    const dialog = await openImport();
    fireEvent.click(screen.getByRole("button", { name: "网址" }));
    fireEvent.change(screen.getByLabelText(/^网址/), { target: { value: "https://127.0.0.1/a.md" } });
    fireEvent.click(screen.getByRole("button", { name: "检查" }));
    expect(await screen.findByText(/不允许访问/)).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
  });
});

describe("让模型帮我找（技能目录）", () => {
  it("「新增技能」菜单里有入口，打开查找对话框", async () => {
    mockApi();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /新增技能|添加技能/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "让模型帮我找" }));
    expect(await screen.findByRole("dialog", { name: "让模型帮我找" })).toBeInTheDocument();
  });

  it("MCP 市场交过来的技能候选：打开导入对话框，停在 ClawHub 并填好地址", async () => {
    mockApi();
    const candidate = { kind: "skill", source: "clawhub", url: "https://clawhub.ai/alice/skills/minutes", title: "会议纪要", summary: "", reason: "", verified: true };
    renderPage(["owner"], { assistCandidate: candidate });
    const dialog = await screen.findByRole("dialog", { name: "导入技能" });
    expect(within(dialog).getByRole("button", { name: "ClawHub" })).toHaveAttribute("aria-current", "page");
    expect(within(dialog).getByDisplayValue("https://clawhub.ai/alice/skills/minutes")).toBeInTheDocument();
  });
});
