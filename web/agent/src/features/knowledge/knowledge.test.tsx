import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppProvider } from "../../lib/app-context";
import { KnowledgePage } from "./KnowledgePage";

const kb = { kb_id: "kb-1", name: "产品文档", description: "", doc_count: 1, size_kb: 10, source_type: "manager", sync_status: "idle" };
const doc = { doc_id: "d1", kb_id: "kb-1", title: "API 指南", snippet: "说明", content_type: "text/plain", size: 10, status: "ready", rag_document_id: "r1", ingestion_job_id: null, error_code: null, error_message: null, chunk_count: 1, source_kind: "file", source_url: "", created_at: "", updated_at: "" };
const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; localStorage.clear(); });
function login() {
  localStorage.setItem("aiteam.agent.token", "test");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify({ user_id: "u1", tenant_id: "t1", roles: ["member"], exp: 9999999999 }));
}
function renderPage() { return render(<MemoryRouter><AppProvider><KnowledgePage /></AppProvider></MemoryRouter>); }

describe("KnowledgePage", () => {
  it("renders authorized knowledge as read-only", async () => {
    login();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const data = url.endsWith("/knowledge-bases") ? [kb] : url.includes("/documents") ? [doc] : [];
      return new Response(JSON.stringify({ data, page: { next_cursor: null, has_more: false } }), { status: 200 });
    }) as typeof fetch;
    renderPage();
    await waitFor(() => expect(screen.getByText("产品文档")).toBeInTheDocument());
    fireEvent.click(screen.getByText("产品文档"));
    await waitFor(() => expect(screen.getByText("API 指南")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "选择文件" })).toBeNull();
    expect(screen.queryByRole("button", { name: "导入" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });
});
