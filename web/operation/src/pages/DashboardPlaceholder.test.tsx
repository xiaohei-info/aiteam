import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n, sharedMessages } from "@aiteam/shared";
import { I18nContext } from "../i18n/context";
import { operationMessages } from "../i18n/messages";
import { DashboardPlaceholder } from "./DashboardPlaceholder";

const getBoard = vi.fn();

vi.mock("../features/board/useBoardApi", () => ({
  useBoardApi: () => ({ getBoard }),
}));

function renderDashboard() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", operationMessages["zh-CN"]!);
  return render(
    <I18nContext.Provider value={i18n}>
      <DashboardPlaceholder />
    </I18nContext.Provider>,
  );
}

describe("DashboardPlaceholder", () => {
  beforeEach(() => {
    getBoard.mockReset();
  });

  it("加载时暴露命名 status 且不渲染旧 glass 节点", () => {
    getBoard.mockImplementation(() => new Promise(() => {}));
    const { container } = renderDashboard();

    expect(screen.getByRole("status", { name: "运营概览加载中" })).toBeInTheDocument();
    expect(container.querySelector(".glass")).toBeNull();
  });

  it("用命名指标卡展示跨企业汇总", async () => {
    getBoard.mockResolvedValue({
      enterprise_count: 5,
      run_count: 12345,
      token_total: 5000000,
      cost_total: 987650,
      error_count: 20,
      duration_seconds_total: 154312,
      enterprises: [],
    });
    renderDashboard();

    expect(await screen.findByRole("heading", { level: 1, name: "概览" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "企业数：5" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "执行次数：12,345" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "总消耗：¥9,876.50" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "总 Token：5,000,000" })).toBeInTheDocument();
  });

  it("加载失败使用 alert 并提供可聚焦重试", async () => {
    getBoard.mockRejectedValue(new Error("network down"));
    renderDashboard();

    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
    const retry = screen.getByRole("button", { name: "重试" });
    retry.focus();
    expect(retry).toHaveFocus();
  });

  it("空结果使用明确 empty state", async () => {
    getBoard.mockResolvedValue(null);
    renderDashboard();

    expect(await screen.findByText("暂无运营汇总数据")).toBeInTheDocument();
  });
});
