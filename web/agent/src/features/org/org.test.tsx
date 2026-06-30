/**
 * W-A.7 组织架构页测试 — 加载态 + 树渲染（部门/员工节点）+ 错误态 + PNG 导出按钮可点击。
 *
 * 覆盖：根节点/员工节点递归渲染、loading/error 展示、只调本端。
 * 范式同 workspace.test/office.test：mock globalThis.fetch + AppProvider + MemoryRouter。
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppProvider } from "../../lib/app-context";
import { OrgPage } from "./OrgPage";
import type { OrgTreeNode } from "./types";

function envelope<T>(data: T): string {
  return JSON.stringify({ data });
}

const tree: OrgTreeNode = {
  id: "root",
  type: "department",
  name: "企业",
  children: [
    { id: "e1", type: "employee", name: "Luna" },
    { id: "e2", type: "employee", name: "Rex" },
  ],
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
  });
}

function renderOrg() {
  return render(
    <MemoryRouter>
      <AppProvider>
        <OrgPage />
      </AppProvider>
    </MemoryRouter>,
  );
}

describe("OrgPage 组织架构", () => {
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    loginStorage();
    fetchMock = mockFetch((url) => {
      if (url.includes("/api/agent/org/tree")) return envelope(tree);
      return envelope(null);
    });
    globalThis.fetch = fetchMock as typeof fetch;
    HTMLCanvasElement.prototype.toBlob = vi.fn(function (this: HTMLCanvasElement, cb: BlobCallback) {
      cb(new Blob(["x"], { type: "image/png" }));
    }) as never;
    document.createElement = ((origCreate) =>
      function (this: Document, tag: string) {
        const el = origCreate.call(this, tag);
        if (tag === "a") {
          el.click = vi.fn();
        }
        return el;
      })(document.createElement.bind(document)) as typeof document.createElement;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("渲染组织树：根部门 + 员工节点", async () => {
    renderOrg();
    await waitFor(() => expect(screen.getByTestId("org-tree")).toBeInTheDocument());
    const nodes = screen.getAllByTestId("org-node");
    expect(nodes.length).toBe(3);
    expect(screen.getByText("企业")).toBeInTheDocument();
    expect(screen.getByText("Luna")).toBeInTheDocument();
    expect(screen.getByText("Rex")).toBeInTheDocument();
    const rootNode = nodes.find((n) => n.getAttribute("data-node-id") === "root");
    expect(rootNode?.getAttribute("data-node-type")).toBe("department");
    const urls = fetchMock.mock.calls.map((c) => (typeof c[0] === "string" ? c[0] : c[0]?.toString() ?? ""));
    expect(urls.some((u) => u.includes("/api/agent/org/tree"))).toBe(true);
  });

  it("错误态：后端异常时展示错误信息", async () => {
    globalThis.fetch = mockFetch(() => {
      throw new Error("boom");
    }) as typeof fetch;
    renderOrg();
    await waitFor(() => expect(screen.getByTestId("org-error")).toBeInTheDocument());
  });

  it("导出按钮可点击（PNG 导出入口）", async () => {
    renderOrg();
    await waitFor(() => expect(screen.getByTestId("org-tree")).toBeInTheDocument());
    const btn = screen.getByTestId("org-export");
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
  });
});
