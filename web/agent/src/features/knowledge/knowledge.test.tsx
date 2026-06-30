/**
 * P08 知识库页测试 — 上传 / 搜索 + 错误态。
 *
 * 覆盖：知识库列表渲染、搜索触发 POST /search、上传触发 POST /documents、
 * 后端失败时展示 actionError（不假成功写入 UI 状态）。
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppProvider } from "../../lib/app-context";
import { KnowledgePage } from "./KnowledgePage";

function listEnvelope<T>(items: T[]): string {
  return JSON.stringify({ data: items, page: { next_cursor: null, has_more: false } });
}

const kb1 = {
  kb_id: "kb-1", name: "产品文档", description: "", doc_count: 42,
  size_kb: 10240, source_type: "upload", sync_status: "idle",
};
const kb2 = {
  kb_id: "kb-2", name: "技术规范", description: "", doc_count: 12,
  size_kb: 2048, source_type: "upload", sync_status: "syncing",
};

const searchResults = [
  { doc_id: "d1", title: "API 设计指南", snippet: "本文档描述...", score: 0.92 },
  { doc_id: "d2", title: "部署手册", snippet: "部署前请确认...", score: 0.78 },
];

function loginStorage() {
  const claims = { user_id: "u1", tenant_id: "t1", enterprise_id: null, roles: ["member"], exp: 9999999999 };
  localStorage.setItem("aiteam.agent.token", "test-tok");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify(claims));
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AppProvider>
        <KnowledgePage />
      </AppProvider>
    </MemoryRouter>,
  );
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.clear();
});

describe("KnowledgePage", () => {
  it("渲染知识库列表", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/knowledge-bases") && !url.includes("/search") && !url.includes("/documents")) {
        return new Response(listEnvelope([kb1, kb2]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/documents") || url.includes("/ingestions")) {
        return new Response(JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByText("产品文档")).toBeInTheDocument());
    expect(screen.getByText("技术规范")).toBeInTheDocument();
    expect(screen.getByText(/42.*文档/)).toBeInTheDocument();
  });

  it("选中知识库后显示搜索/上传面板", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/knowledge-bases") && !url.includes("/search") && !url.includes("/documents")) {
        return new Response(listEnvelope([kb1]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/documents") || url.includes("/ingestions")) {
        return new Response(JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByText("产品文档")).toBeInTheDocument());
    fireEvent.click(screen.getByText("产品文档"));

    expect(screen.getByPlaceholderText("语义搜索…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "搜索" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择文件" })).toBeInTheDocument();
  });

  it("搜索知识库 → 展示搜索结果", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/search")) {
        return new Response(listEnvelope(searchResults), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/knowledge-bases") && !url.includes("/search") && !url.includes("/documents")) {
        return new Response(listEnvelope([kb1]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/documents") || url.includes("/ingestions")) {
        return new Response(JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByText("产品文档")).toBeInTheDocument());
    fireEvent.click(screen.getByText("产品文档"));

    fireEvent.change(screen.getByPlaceholderText("语义搜索…"), { target: { value: "部署" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    await waitFor(() => {
      expect(screen.getByText("API 设计指南")).toBeInTheDocument();
      expect(screen.getByText("部署手册")).toBeInTheDocument();
      expect(screen.getByText(/92%/)).toBeInTheDocument();
    });
  });

  it("搜索失败 → 展示 actionError（不替换整页面）", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/search")) {
        return new Response(
          JSON.stringify({ type: "about:blank", title: "搜索失败", status: 500, code: "search_error", detail: "索引不可用" }),
          { status: 500, headers: { "content-type": "application/problem+json" } },
        );
      }
      if (url.includes("/knowledge-bases") && !url.includes("/search") && !url.includes("/documents")) {
        return new Response(listEnvelope([kb1]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/documents") || url.includes("/ingestions")) {
        return new Response(JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByText("产品文档")).toBeInTheDocument());
    fireEvent.click(screen.getByText("产品文档"));
    fireEvent.change(screen.getByPlaceholderText("语义搜索…"), { target: { value: "部署" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    await waitFor(() => {
      expect(screen.getByText(/搜索失败|索引不可用/)).toBeInTheDocument();
    });
    // 列表仍在
    expect(screen.getByText("产品文档")).toBeInTheDocument();
  });

  it("上传失败 → 展示 actionError", async () => {
    loginStorage();
    const fetchCalls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      fetchCalls.push(`${method} ${url}`);
      if (url.includes("/documents") && method === "POST") {
        return new Response(
          JSON.stringify({ type: "about:blank", title: "上传失败", status: 413, code: "file_too_large", detail: "文件超过 10MB 限制" }),
          { status: 413, headers: { "content-type": "application/problem+json" } },
        );
      }
      if (url.includes("/knowledge-bases") && !url.includes("/search") && !url.includes("/documents")) {
        return new Response(listEnvelope([kb1]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/documents") || url.includes("/ingestions")) {
        return new Response(JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByText("产品文档")).toBeInTheDocument());
    fireEvent.click(screen.getByText("产品文档"));

    // 模拟文件选择：点击上传按钮 → 隐藏 file input onChange 触发
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const testFile = new File(["dummy content"], "test.pdf", { type: "application/pdf" });
    // jsdom 不支持 DataTransfer，直接用 vi.fn 替代
    Object.defineProperty(fileInput, "files", { value: [testFile], writable: false });
    fireEvent.change(fileInput);

    await waitFor(() => {
      expect(screen.getByText(/上传失败|文件超过 10MB/)).toBeInTheDocument();
    });
  });

  it("加载失败展示错误面板（替换页面内容）", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ type: "about:blank", title: "Server Error", status: 500, code: "internal", detail: "数据库不可达" }),
        { status: 500, headers: { "content-type": "application/problem+json" } },
      ),
    ) as typeof fetch;

    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/数据库不可达/)).toBeInTheDocument();
    });
  });
});

describe("URL 导入", () => {
  it("选中 KB 后 URL 标签页出现并导入 URL 后刷新文档列表", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/knowledge-bases") && !url.includes("/search") && !url.includes("/documents") && !url.includes("/ingestions")) {
        return new Response(listEnvelope([kb1]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/documents") || url.includes("/ingestions")) {
        // 首次列表 + URL import 后刷新（id 不同） {
        if (method === "GET") {
          return new Response(JSON.stringify({
            data: [{ doc_id: "du1", kb_id: kb1.kb_id, title: "导入的网页", snippet: "", content_type: "text/html",
                     size: 123, status: "ready", rag_document_id: "rag-x", ingestion_job_id: "j1",
                     error_code: null, error_message: null, chunk_count: 1, source_kind: "url",
                     source_url: "https://example.com/x", created_at: "", updated_at: "" }],
            page: { next_cursor: null, has_more: false },
          }), { status: 200 });
        }
        if (url.endsWith("/url") && method === "POST") {
          const body = init?.body ? JSON.parse(init.body as string) : {};
          return new Response(JSON.stringify({ data: {
            doc_id: "du1", kb_id: kb1.kb_id, title: body.title ?? "导入的网页",
            snippet: "hello world", content_type: "text/html", size: 123, status: "ready",
            rag_document_id: "rag-x", ingestion_job_id: "j1", error_code: null, error_message: null,
            chunk_count: 1, source_kind: "url", source_url: body.url, created_at: "", updated_at: "",
          } }), { status: 200 });
        }
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByText("产品文档")).toBeInTheDocument());
    fireEvent.click(screen.getByText("产品文档"));

    // 切换到 URL 标签页
    fireEvent.click(screen.getByText("从 URL 导入"));
    const urlInput = screen.getByPlaceholderText("https://example.com/article");
    fireEvent.change(urlInput, { target: { value: "https://example.com/x" } });
    fireEvent.click(screen.getByRole("button", { name: "导入" }));

    await waitFor(() => expect(screen.getByText("导入的网页")).toBeInTheDocument());
    expect(screen.getByText("导入的网页")).toBeInTheDocument();
    expect(screen.getByText("URL")).toBeInTheDocument();
  });

  it("URL 导入失败展示 actionError", async () => {
    loginStorage();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/knowledge-bases") && !url.includes("/search") && !url.includes("/documents") && !url.includes("/ingestions")) {
        return new Response(listEnvelope([kb1]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/url") && (init?.method ?? "GET").toUpperCase() === "POST") {
        return new Response(
          JSON.stringify({ type: "about:blank", title: "导入失败", status: 501, code: "httpx_missing", detail: "httpx 未安装" }),
          { status: 501, headers: { "content-type": "application/problem+json" } },
        );
      }
      if (url.includes("/documents") || url.includes("/ingestions")) {
        return new Response(JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    renderPage();
    await waitFor(() => expect(screen.getByText("产品文档")).toBeInTheDocument());
    fireEvent.click(screen.getByText("产品文档"));
    fireEvent.click(screen.getByText("从 URL 导入"));
    fireEvent.change(screen.getByPlaceholderText("https://example.com/article"), { target: { value: "https://example.com/x" } });
    fireEvent.click(screen.getByRole("button", { name: "导入" }));

    await waitFor(() => expect(screen.getByText(/导入失败|httpx 未安装/)).toBeInTheDocument());
  });
});
