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
  it("renders a read-only catalog without a recruitment or publishing action", async () => {
    login();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [template], page: { next_cursor: null, has_more: false } }), { status: 200 })) as typeof fetch;
    renderPage();
    await waitFor(() => expect(screen.getByText("营销专家A")).toBeInTheDocument());
    expect(screen.getByText("请在 Manager 端配置")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-aiteam-avatar="true"]')).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "招募" })).toBeNull();
    expect(screen.queryByRole("button", { name: "发布需求" })).toBeNull();
    expect(screen.queryByRole("button", { name: /上架/ })).toBeNull();
    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.endsWith("/api/agent/marketplace/templates"))).toBe(true);
    expect(urls.some((url) => url.includes("/templates/"))).toBe(false);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("does not fabricate a commercial recruitment count when upstream has no data", async () => {
    login();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ ...template, recruit_count: null }] }), { status: 200 })) as typeof fetch;
    renderPage();
    await waitFor(() => expect(screen.getByText("营销专家A")).toBeInTheDocument());
    expect(screen.queryByText(/次招募|家企业招募/)).toBeNull();
  });

  it("projects an empty Agent catalog explicitly", async () => {
    login();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }), { status: 200 })) as typeof fetch;
    renderPage();
    await waitFor(() => expect(screen.getByTestId("marketplace-empty")).toBeInTheDocument());
    expect(screen.getByText(/没有收到可读取的目录投影/)).toBeInTheDocument();
  });

  it("projects a catalog problem response as an error", async () => {
    login();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ type: "about:blank", title: "Unavailable", status: 503, code: "manager_unavailable", detail: "目录暂不可用" }), { status: 503, headers: { "content-type": "application/problem+json" } })) as typeof fetch;
    renderPage();
    await waitFor(() => expect(screen.getByText("目录暂不可用")).toBeInTheDocument());
    expect(screen.queryByTestId("marketplace-empty")).toBeNull();
  });
});
