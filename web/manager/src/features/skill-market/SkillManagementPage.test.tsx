import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { I18nContext } from "../../i18n/context";
import { managerMessages } from "../../i18n/messages";
import { SkillManagementPage } from "./SkillManagementPage";
import { resetCapabilityUpdates } from "../capability-updates";

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
  it("默认「企业技能」：技能目录与「新增技能」菜单（导入 / 让模型帮我找 / 从零写一个），不带连接器与记忆", async () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "技能管理" })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "技能目录" });
    expect(await within(table).findByText("weekly-report")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "连接器目录" })).toBeNull();
    expect(screen.queryByRole("table", { name: "记忆策略目录" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "新增技能" }));
    for (const name of ["导入技能", "让模型帮我找", "从零写一个"]) expect(await screen.findByRole("menuitem", { name })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "导入技能" }));
    expect(await screen.findByRole("dialog", { name: "导入技能" })).toBeInTheDocument();
  });

  it("切到「平台技能市场」显示运营端开放的技能，不再说 Manager 不连外部市场", async () => {
    renderPage();
    await screen.findByRole("table", { name: "技能目录" });
    fireEvent.click(screen.getByRole("button", { name: "平台技能市场" }));
    expect(await screen.findByText("Demo")).toBeInTheDocument();
    expect(screen.queryByText(/不直接连接外部市场/)).toBeNull();
    expect(screen.queryByRole("table", { name: "技能目录" })).toBeNull();
  });

  it("MCP 市场交过来的技能候选：直接打开预填的导入对话框", async () => {
    renderPage({ assistCandidate: { kind: "skill", source: "clawhub", url: "https://clawhub.ai/steipete/skills/weather", title: "weather", summary: "", reason: "", verified: true } });
    const dialog = await screen.findByRole("dialog", { name: "导入技能" });
    expect(within(dialog).getByDisplayValue("https://clawhub.ai/steipete/skills/weather")).toBeInTheDocument();
  });

  it("平台技能有新版本：「企业技能」标签带红点；没有更新时不显示", async () => {
    const platformSkill = { ...skill, catalog_id: "platform-p1", skill_id: "weather", config: { source: "operator", source_skill_id: "p1" } };
    capabilityApi.listSkills.mockResolvedValue([platformSkill]);
    marketApi.list.mockResolvedValue([{ skill_id: "p1", owner: "platform", slug: "weather", display_name: "weather", summary: "", published_version: "2.0.0", content_hash: "h2", status: "published", installed: true, update_available: true }]);
    const view = renderPage();
    const enterpriseTab = () => document.querySelector<HTMLElement>('[data-tab-value="enterprise"]')!;
    await screen.findByRole("table", { name: "技能目录" });
    expect(await within(enterpriseTab()).findByLabelText("1 项有更新")).toBeInTheDocument();
    view.unmount();
    resetCapabilityUpdates();
    marketApi.list.mockClear();
    marketApi.list.mockResolvedValue([{ skill_id: "p1", owner: "platform", slug: "weather", display_name: "weather", summary: "", published_version: "2.0.0", content_hash: "h2", status: "published", installed: true, update_available: false }]);
    renderPage();
    await screen.findByRole("table", { name: "技能目录" });
    await waitFor(() => expect(marketApi.list).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(within(enterpriseTab()).queryByLabelText(/项有更新/)).toBeNull();
  });
});
