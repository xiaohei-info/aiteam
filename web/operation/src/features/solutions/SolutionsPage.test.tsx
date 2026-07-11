import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { SolutionsPage } from "./SolutionsPage";

const session: SessionContextValue = {
  session: {
    principal: { id: "u1", display_name: "管理员", status: "active", roles: ["system_admin"] },
    claims: { user_id: "u1", roles: ["system_admin"], exp: Math.floor(Date.now() / 1000) + 3600 },
  },
  token: "token",
  signIn: () => {},
  signOut: () => {},
  onUnauthorized: () => {},
};

function renderPage() {
  return render(
    <SessionContext.Provider value={session}>
      <MemoryRouter><SolutionsPage /></MemoryRouter>
    </SessionContext.Provider>,
  );
}

describe("SolutionsPage", () => {
  beforeEach(() => { globalThis.fetch = vi.fn(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("使用命名 Astryx 表格展示方案统计", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ data: [{ solution_id: "sol-1", name: "零售方案", apply_count: 8, active_enterprises: 3 }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const { container } = renderPage();
    expect(await screen.findByRole("table", { name: "行业方案统计" })).toBeInTheDocument();
    expect(screen.getByText("零售方案")).toBeInTheDocument();
    expect(container.querySelector(".glass")).toBeNull();
  });

  it("暴露 loading、error 与 empty 语义", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() => new Promise(() => {}));
    const pending = renderPage();
    expect(screen.getByRole("status", { name: "方案统计加载中" })).toBeInTheDocument();
    pending.unmount();

    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("offline"));
    const failed = renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    failed.unmount();

    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    renderPage();
    expect(await screen.findByText("暂无方案数据")).toBeInTheDocument();
  });

  it("失败后可以重试并恢复", async () => {
    vi.mocked(globalThis.fetch)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ solution_id: "sol-2", name: "恢复方案", apply_count: 1, active_enterprises: 1 }] }), { status: 200, headers: { "content-type": "application/json" } }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText("恢复方案")).toBeInTheDocument();
  });
});
