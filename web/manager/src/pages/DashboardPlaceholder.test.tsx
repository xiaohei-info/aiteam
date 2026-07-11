import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n, sharedMessages } from "@aiteam/shared";
import { I18nContext } from "../i18n/context";
import { managerMessages } from "../i18n/messages";
import { DashboardPlaceholder } from "./DashboardPlaceholder";

const listUsageRollups = vi.fn();
const listAudits = vi.fn();

vi.mock("../features/governance/useGovernanceApi", () => ({
  useGovernanceApi: () => ({ listUsageRollups, listAudits }),
}));

function renderDashboard() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", managerMessages["zh-CN"]!);
  return render(
    <I18nContext.Provider value={i18n}>
      <DashboardPlaceholder />
    </I18nContext.Provider>,
  );
}

describe("DashboardPlaceholder", () => {
  beforeEach(() => {
    listUsageRollups.mockReset();
    listAudits.mockReset();
  });

  it("用命名表格展示计量与审计摘要", async () => {
    listUsageRollups.mockResolvedValue([{ rollup_id: "r1", employee_id: "e1", run_count: 2, token_total: 30, cost_total: 400, error_count: 0 }]);
    listAudits.mockResolvedValue([{ event_id: "a1", actor: "owner", action: "member.created", resource_type: "member", resource_id: "m1", occurred_at: "2026-07-11T08:00:00Z" }]);
    renderDashboard();

    expect(await screen.findByRole("heading", { level: 1, name: "企业概览" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "计量汇总" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "审计事件" })).toBeInTheDocument();
  });

  it("加载失败使用 alert", async () => {
    listUsageRollups.mockRejectedValue(new Error("network down"));
    listAudits.mockResolvedValue([]);
    renderDashboard();
    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
  });
});
