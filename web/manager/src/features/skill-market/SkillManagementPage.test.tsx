import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { I18nContext } from "../../i18n/context";
import { managerMessages } from "../../i18n/messages";
import { SkillManagementPage } from "./SkillManagementPage";
import { resetCapabilityUpdates, useCapabilityUpdateCounts } from "../capability-updates";

const skill = { catalog_id: "c1", skill_id: "weekly-report", display_name: "weekly-report", version: "1.0.0", install_policy: "on_demand", binding_policy: "opt_in", visibility: "tenant", config: { source: "url" }, catalog_version: 1 };
const capabilityApi = {
  listSkills: vi.fn(), listConnectors: vi.fn(), listMemoryPolicies: vi.fn(),
  previewSkillImport: vi.fn(), importSkills: vi.fn(),
};
vi.mock("../capability/useCapabilityApi", () => ({ useCapabilityApi: () => capabilityApi }));
const marketApi = { list: vi.fn(), install: vi.fn() };
vi.mock("./useSkillMarketApi", () => ({ useSkillMarketApi: () => marketApi }));
const modelsApi = { list: async () => ({ providers: [], models: [] }) };
vi.mock("../platform-models/usePlatformModelsApi", () => ({ usePlatformModelsApi: () => modelsApi }));

function renderPage(state?: unknown) {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", managerMessages["zh-CN"]!);
  const roles = ["enterprise_admin"];
  const session = {
    session: {
      principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles },
      claims: { user_id: "u1", tenant_id: "t1", roles, exp: Math.floor(Date.now() / 1000) + 3600 },
    } as AuthSession,
    token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {},
  } as SessionContextValue;
  return render(
    <I18nContext.Provider value={i18n}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[{ pathname: "/skill-market", state }]}><SkillManagementPage /></MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCapabilityUpdates();
  capabilityApi.listSkills.mockResolvedValue([skill]);
  capabilityApi.listConnectors.mockResolvedValue([]);
  capabilityApi.listMemoryPolicies.mockResolvedValue([]);
  marketApi.list.mockResolvedValue([{ skill_id: "s1", owner: "pub", slug: "demo", display_name: "Demo", summary: "x", published_version: "1.0.0", content_hash: "h", status: "published", installed: false, update_available: false }]);
});

describe("技能管理（侧栏入口）", () => {
  it("只有一个技能列表（不分标签）；「新增技能」菜单含添加平台技能 / 导入 / 让模型帮我找 / 从零写一个，不带连接器与记忆", async () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "技能管理" })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "技能目录" });
    expect(await within(table).findByText("weekly-report")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "连接器目录" })).toBeNull();
    expect(screen.queryByRole("table", { name: "记忆策略目录" })).toBeNull();
    expect(screen.queryByRole("button", { name: "平台技能市场" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "技能来源" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "新增技能" }));
    for (const name of ["添加平台技能", "导入技能", "让模型帮我找", "从零写一个"]) expect(await screen.findByRole("menuitem", { name })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "导入技能" }));
    expect(await screen.findByRole("dialog", { name: "导入技能" })).toBeInTheDocument();
  });

  it("新增技能 → 添加平台技能：列出运营端开放的技能，添加后刷新企业技能列表，对话框保留可继续添加", async () => {
    marketApi.list.mockResolvedValue([
      { skill_id: "s1", owner: "pub", slug: "demo", display_name: "Demo", summary: "演示", published_version: "1.0.0", content_hash: "h", status: "published", installed: false, update_available: false, namespace: "taiyim" },
      { skill_id: "s2", owner: "pub", slug: "notes", display_name: "Notes", summary: "", published_version: "2.0.0", content_hash: "h2", status: "published", installed: true, update_available: false, namespace: "taiyim" },
      { skill_id: "s3", owner: "pub", slug: "weather", display_name: "Weather", summary: "", published_version: "3.0.0", content_hash: "h3", status: "published", installed: true, update_available: true, namespace: "taiyim" },
    ]);
    marketApi.install.mockResolvedValue({});
    renderPage();
    await screen.findByRole("table", { name: "技能目录" });
    const listCalls = capabilityApi.listSkills.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "新增技能" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "添加平台技能" }));
    const dialog = await screen.findByRole("dialog", { name: "添加平台技能" });
    const list = await within(dialog).findByRole("list", { name: "平台技能" });
    expect(within(list).getByText("taiyim/Demo")).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "已添加 taiyim/Notes" })).toBeDisabled();
    expect(within(list).getByRole("button", { name: "更新 taiyim/Weather" })).toBeEnabled();
    expect(within(list).getByText("平台有新版本")).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: "添加 taiyim/Demo" }));
    await waitFor(() => expect(marketApi.install).toHaveBeenCalledWith(expect.objectContaining({ skill_id: "s1", published_version: "1.0.0" })));
    expect(await within(dialog).findByText("已添加 taiyim/Demo 到企业技能")).toBeInTheDocument();
    await waitFor(() => expect(capabilityApi.listSkills.mock.calls.length).toBeGreaterThan(listCalls));
    expect(screen.getByRole("dialog", { name: "添加平台技能" })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByPlaceholderText("按名称、说明搜索"), { target: { value: "weather" } });
    expect(within(list).queryByText("taiyim/Demo")).toBeNull();
    expect(within(list).getByText("taiyim/Weather")).toBeInTheDocument();
  });

  it("MCP 市场交过来的技能候选：直接打开预填的导入对话框", async () => {
    renderPage({ assistCandidate: { kind: "skill", source: "clawhub", url: "https://clawhub.ai/steipete/skills/weather", title: "weather", summary: "", reason: "", verified: true } });
    const dialog = await screen.findByRole("dialog", { name: "导入技能" });
    expect(within(dialog).getByDisplayValue("https://clawhub.ai/steipete/skills/weather")).toBeInTheDocument();
  });

  it("平台技能有新版本：列表行提示「平台有新版本」，侧栏红点的计数随之上报", async () => {
    const platformSkill = { ...skill, catalog_id: "platform-p1", skill_id: "weather", config: { source: "operator", source_skill_id: "p1" } };
    capabilityApi.listSkills.mockResolvedValue([platformSkill]);
    marketApi.list.mockResolvedValue([{ skill_id: "p1", owner: "platform", slug: "weather", display_name: "weather", summary: "", published_version: "2.0.0", content_hash: "h2", status: "published", installed: true, update_available: true }]);
    const { result } = renderHook(() => useCapabilityUpdateCounts());
    renderPage();
    const table = await screen.findByRole("table", { name: "技能目录" });
    expect(await within(table).findByText("平台有新版本")).toBeInTheDocument();
    await waitFor(() => expect(result.current.skills).toBe(1));
  });
});
