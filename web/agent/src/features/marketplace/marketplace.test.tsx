/**
 * P03 人才市场页测试 — 招募流程 + 错误态。
 *
 * 覆盖：模板列表渲染、招募按钮点击 → POST /api/agent/recruitments、
 * 招募后重新拉取列表、后端失败时展示真实错误（不假成功写入 UI 状态）。
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppProvider } from "../../lib/app-context";
import { MarketplacePage } from "./MarketplacePage";

function listEnvelope<T>(items: T[]): string {
  return JSON.stringify({ data: items, page: { next_cursor: null, has_more: false } });
}

function envelope<T>(data: T): string {
  return JSON.stringify({ data });
}

const tplA = {
  template_id: "t1", display_name: "营销专家A", category: "市场营销", model_name: "gpt-5",
  skills_count: 12, recruit_count: 8, is_recruited: false, tags: ["营销", "文案", "数据分析"],
  avatar_url: null,
};
const tplRecruited = {
  template_id: "t2", display_name: "已招募专家", category: "技术研发", model_name: "claude-sonnet",
  skills_count: 6, recruit_count: 3, is_recruited: true, tags: [], avatar_url: null,
};

function loginStorage() {
  const claims = { user_id: "u1", tenant_id: "t1", enterprise_id: null, roles: ["member"], exp: 9999999999 };
  localStorage.setItem("aiteam.agent.token", "test-tok");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify(claims));
}

function mockFetch(handler: (url: string, method: string) => string) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    return new Response(handler(url, method), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AppProvider>
        <MarketplacePage />
      </AppProvider>
    </MemoryRouter>,
  );
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.clear();
});

describe("MarketplacePage", () => {
  it("渲染模板列表（含已招募标记）", async () => {
    loginStorage();
    globalThis.fetch = mockFetch((url) => {
      if (url.includes("/marketplace/templates")) return listEnvelope([tplA, tplRecruited]);
      return listEnvelope([]);
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("营销专家A")).toBeInTheDocument());
    expect(screen.getByText("已招募专家")).toBeInTheDocument();
    // 已招募模板不显示"招募"按钮
    expect(screen.getByText("✓ 已招募")).toBeInTheDocument();
    // 未招募模板显示招募按钮
    expect(screen.getByRole("button", { name: "招募" })).toBeInTheDocument();
  });

  it("招募按钮点击 → POST /api/agent/recruitments，成功后重新拉取列表", async () => {
    loginStorage();
    const calls: string[] = [];
    globalThis.fetch = mockFetch((url, method) => {
      calls.push(`${method} ${url}`);
      if (url.includes("/marketplace/templates")) return listEnvelope([tplA]);
      if (url.includes("/recruitments")) return envelope({ success: true, employee_id: "e-new", message: "招募成功" });
      return listEnvelope([]);
    });

    renderPage();
    await waitFor(() => expect(screen.getByText("营销专家A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "招募" }));

    await waitFor(() => {
      const postCall = calls.find((c) => c.startsWith("POST") && c.includes("/recruitments"));
      expect(postCall).toBeTruthy();
    });
    // 招募后重新拉取模板列表
    const templateCalls = calls.filter((c) => c.includes("/marketplace/templates"));
    expect(templateCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("招募失败 → 展示错误消息（不替换整页面为空白错误面板）", async () => {
    loginStorage();
    let callCount = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      // 第一次列表加载成功，招募返回 500
      if (url.includes("/marketplace/templates")) {
        callCount++;
        return new Response(listEnvelope([tplA]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/recruitments") && method === "POST") {
        return new Response(
          JSON.stringify({ type: "about:blank", title: "招募失败", status: 500, code: "recruit_error", detail: "Manager 不可达" }),
          { status: 500, headers: { "content-type": "application/problem+json" } },
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByText("营销专家A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "招募" }));

    // 错误消息内联展示，模板列表仍可见
    await waitFor(() => {
      expect(screen.getByText(/招募失败|Manager 不可达/)).toBeInTheDocument();
    });
    expect(screen.getByText("营销专家A")).toBeInTheDocument();
  });

  it("加载失败展示错误面板（替换页面内容）", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ type: "about:blank", title: "Server Error", status: 500, code: "internal", detail: "boom" }),
        { status: 500, headers: { "content-type": "application/problem+json" } },
      ),
    ) as typeof fetch;

    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/boom/)).toBeInTheDocument();
    });
    // 加载失败时模板列表不渲染
    expect(screen.queryByText("营销专家A")).toBeNull();
  });
});
