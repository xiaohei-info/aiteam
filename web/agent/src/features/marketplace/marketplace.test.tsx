import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppProvider } from "../../lib/app-context";
import { MarketplacePage } from "./MarketplacePage";

const template = {
  template_id: "t1", display_name: "营销专家A", category: "市场营销", model_name: "gpt-5",
  skills_count: 12, recruit_count: 8, is_recruited: false, tags: ["营销"], avatar_url: null,
};
const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; localStorage.clear(); });
function renderPage() {
  return render(<MemoryRouter><AppProvider><MarketplacePage /></AppProvider></MemoryRouter>);
}
function login() {
  localStorage.setItem("aiteam.agent.token", "test");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify({ user_id: "u1", tenant_id: "t1", roles: ["member"], exp: 9999999999 }));
}

describe("MarketplacePage", () => {
  it("renders a read-only catalog without a recruitment action", async () => {
    login();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [template], page: { next_cursor: null, has_more: false } }), { status: 200 })) as typeof fetch;
    renderPage();
    await waitFor(() => expect(screen.getByText("营销专家A")).toBeInTheDocument());
    expect(screen.getByText("请在 Manager 端配置")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "招募" })).toBeNull();
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });
});
