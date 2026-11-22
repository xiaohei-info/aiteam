import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { EmployeeConfigDrawer } from "../EmployeeConfigDrawer";
import { useExpertsApi } from "../useExpertsApi";
import { usePlatformModelsApi } from "../../platform-models/usePlatformModelsApi";
import { useCapabilityApi } from "../../capability/useCapabilityApi";
import type { EmployeeConfig } from "../types";
import type { SkillCatalog } from "../../capability/types";

vi.mock("../useExpertsApi", () => ({ useExpertsApi: vi.fn() }));
vi.mock("../../platform-models/usePlatformModelsApi", () => ({ usePlatformModelsApi: vi.fn() }));
vi.mock("../../capability/useCapabilityApi", () => ({ useCapabilityApi: vi.fn() }));

const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
i18n.extend("zh-CN", managerMessages["zh-CN"]!);

const session = {
  principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles: ["owner"] },
  claims: { user_id: "u1", tenant_id: "t1", roles: ["owner"], exp: Math.floor(Date.now() / 1000) + 3600 },
} as AuthSession;
const sessionValue: SessionContextValue = { session, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };

const catalogSkill = (skill_id: string, extra: Partial<SkillCatalog> = {}): SkillCatalog => ({
  catalog_id: `c-${skill_id}`, skill_id, display_name: skill_id, version: "1", install_policy: "on_demand",
  binding_policy: "opt_in", visibility: "tenant", config: {}, catalog_version: 1, package_status: "ready", ...extra,
});

const employee: EmployeeConfig = {
  employee_id: "emp-1", employee_slug: "hr", version: 1, display_name: "招聘专员", persona: "p",
  model_policy: { model: "", provider_ref: null, thinking_level: null }, execution_policy: { timeout_seconds: null },
  tools: [], skills: ["weekly", "薪酬核算"], knowledge_refs: [], connector_refs: [], memory_policy: null, status: "draft",
  skill_status: [{ ref: "薪酬核算", display_name: "薪酬核算", status: "missing", reason: "已从企业技能库移除，员工现在用不了它" }],
};

function setup(listSkills: ReturnType<typeof vi.fn>) {
  const updateEmployee = vi.fn().mockImplementation(async (_id: string, cfg: unknown) => cfg);
  (useExpertsApi as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ updateEmployee, listEmployees: vi.fn().mockResolvedValue([employee]) });
  (usePlatformModelsApi as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ list: vi.fn().mockResolvedValue({ providers: [], models: [] }) });
  (useCapabilityApi as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ listSkills });
  render(
    <I18nContext.Provider value={i18n}>
      <SessionContext.Provider value={sessionValue}>
        <EmployeeConfigDrawer employeeId="emp-1" employee={employee} onClose={() => {}} onSaved={() => {}} />
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
  return { updateEmployee };
}

describe("员工配置抽屉：技能", () => {
  beforeEach(() => vi.clearAllMocks());

  it("技能库加载失败：说清楚并能重试，不冒充「暂无技能」，也不把已有技能误标为已失效", async () => {
    const listSkills = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue([catalogSkill("weekly")]);
    setup(listSkills);
    expect(await screen.findByText("技能库暂时没加载出来")).toBeInTheDocument();
    expect(screen.queryByText(/暂无企业技能/)).not.toBeInTheDocument();
    expect(screen.queryByText(/已从企业技能库移除/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByText("技能库暂时没加载出来")).not.toBeInTheDocument());
    expect(listSkills).toHaveBeenCalledTimes(2);
  });

  it("员工已有但企业库里没有的技能标为已失效，一键去掉后保存不再带它，也不回写目录状态", async () => {
    const { updateEmployee } = setup(vi.fn().mockResolvedValue([catalogSkill("weekly")]));
    expect(await screen.findByText(/「薪酬核算」已从企业技能库移除，这位员工现在用不了它/)).toBeInTheDocument();
    expect(screen.queryByText(/「weekly」已从企业技能库移除/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "从员工身上去掉" }));
    expect(screen.queryByText(/「薪酬核算」已从企业技能库移除/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(updateEmployee).toHaveBeenCalledTimes(1));
    const saved = updateEmployee.mock.calls[0]![1] as Record<string, unknown>;
    expect(saved.skills).toEqual(["weekly"]);
    expect(saved.skill_status).toBeUndefined();
    expect(saved.connector_status).toBeUndefined();
  });
});
