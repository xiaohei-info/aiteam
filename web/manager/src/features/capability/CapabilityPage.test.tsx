import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { I18nContext } from "../../i18n/context";
import { managerMessages } from "../../i18n/messages";
import { CapabilityPage } from "./CapabilityPage";
import { useCapabilityApi, type CapabilityApi } from "./useCapabilityApi";
import type { ConnectorCatalog, MemoryPolicyCatalog, SkillCatalog } from "./types";

vi.mock("./useCapabilityApi", () => ({ useCapabilityApi: vi.fn() }));

const skill: SkillCatalog = {
  catalog_id: "skill-c1", skill_id: "skill-a", display_name: "技能 A", version: "1",
  install_policy: "on_demand", binding_policy: "opt_in", visibility: "private",
  config: {}, catalog_version: 1,
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

/** 「新增技能」是菜单：导入技能 / 手动编辑（高级）。 */
async function openManualSkillEditor() {
  fireEvent.click(screen.getByRole("button", { name: "新增技能" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "手动编辑（高级）" }));
}

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
    previewSkillImport: vi.fn().mockResolvedValue(null),
    importSkills: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
  (useCapabilityApi as unknown as ReturnType<typeof vi.fn>).mockReturnValue(api);
  return api;
}

function renderPage(roles: string[] = ["owner"]) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue(roles)}>
        <MemoryRouter><CapabilityPage /></MemoryRouter>
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

  it("创建技能：提交默认策略与输入字段", async () => {
    const api = mockApi();
    renderPage();
    await screen.findByText("技能 A");
    await openManualSkillEditor();
    expect(screen.getByRole("dialog", { name: "新增技能" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/标识/), { target: { value: "skill-b" } });
    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: "技能 B" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.createSkill).toHaveBeenCalledWith({
      skill_id: "skill-b",
      display_name: "技能 B",
      version: "1",
      install_policy: "on_demand",
      binding_policy: "opt_in",
      visibility: "private",
      config: {},
    }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新增技能" })).not.toBeInTheDocument());
  });

  it("创建失败：显示错误且保留 Dialog", async () => {
    const api = mockApi({ createSkill: vi.fn().mockRejectedValue(new Error("boom")) });
    renderPage();
    await screen.findByText("技能 A");
    await openManualSkillEditor();
    fireEvent.change(screen.getByLabelText(/标识/), { target: { value: "skill-b" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("操作失败，请重试"));
    expect(screen.getByRole("dialog", { name: "新增技能" })).toBeInTheDocument();
    expect(api.createSkill).toHaveBeenCalledTimes(1);
  });

  it("编辑技能：保存调用 updateSkill", async () => {
    const api = mockApi();
    renderPage();
    await screen.findByText("技能 A");
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    expect(screen.getByRole("dialog", { name: "编辑技能" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: "技能 A+" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.updateSkill).toHaveBeenCalledWith(
      "skill-c1",
      expect.objectContaining({ display_name: "技能 A+" }),
    ));
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

describe("S05 executable skill package contract", () => {
  it("metadata-only edits omit files/hash and show a draft as non-executable", async () => {
    const api = mockApi();
    renderPage();
    expect(await screen.findByText("草稿（不可执行）")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    fireEvent.change(screen.getByLabelText(/名称/), { target: { value: "Only metadata" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.updateSkill).toHaveBeenCalled());
    const body = vi.mocked(api.updateSkill).mock.calls[0]![1];
    expect(body).not.toHaveProperty("files");
    expect(body).not.toHaveProperty("content_hash");
    expect(body.version).toBe("1");
  });

  it("explicit complete package is sent, while malformed JSON is not silently converted to a draft", async () => {
    const api = mockApi({ listSkills: vi.fn().mockResolvedValue([{ ...skill, package_status: "ready" }]) });
    renderPage();
    expect(await screen.findByText("已验证包")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    const input = screen.getByLabelText("完整技能包（JSON 文件数组，可选）");
    fireEvent.change(input, { target: { value: "[invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(api.updateSkill).not.toHaveBeenCalled();
    expect(screen.getByText(/技能包必须是包含 SKILL.md/)).toBeInTheDocument();
    const files = [{ path: "SKILL.md", content: "---\ndescription: Test\n---\nSynthetic instructions" }];
    fireEvent.change(input, { target: { value: JSON.stringify(files) } });
    fireEvent.change(screen.getByLabelText("版本"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.updateSkill).toHaveBeenCalledWith("skill-c1", expect.objectContaining({ files, version: "2" })));
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
    await waitFor(() => expect(api.importSkills).toHaveBeenCalledWith(expect.objectContaining({ source: "text", roots: [""], visibility: "tenant", binding_policy: "opt_in", install_policy: "on_demand" })));
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
