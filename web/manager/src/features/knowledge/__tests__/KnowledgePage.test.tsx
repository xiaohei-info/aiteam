import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import type { ApiClient } from "../../../api/client";
import * as clientMod from "../../../api/client";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { DocumentsPanel } from "../DocumentsPanel";
import { KnowledgePage } from "../KnowledgePage";

const PAGE = { next_cursor: null, has_more: false };
const SPACES = [
  { knowledge_space_id: "enterprise_shared", workspace: "ws1", display_name: "企业知识库" },
];
const EMPLOYEES = { items: [{ employee_id: "e1", display_name: "张三" }], page: PAGE };
const DEPARTMENTS = { items: [{ id: "d1", display_name: "销售部" }], page: PAGE };
const MEMBERS = { items: [{ id: "m1", display_name: "李四" }], page: PAGE };
const BINDINGS = [
  { id: "expert:e1:ks-sales", tenant_id: "t1", knowledge_space_id: "ks-sales", resource_type: "expert", resource_id: "e1", created_at: null },
];
const DOCUMENTS = [
  {
    id: "doc-failed",
    tenant_id: "t1",
    knowledge_space_id: "ks-sales",
    display_name: "销售手册.pdf",
    source_type: "file",
    file_name: "sales.pdf",
    file_type: "pdf",
    file_size: 128,
    storage_key: "documents/sales.pdf",
    status: "failed",
    text_chars: null,
  },
  {
    id: "doc-ready",
    tenant_id: "t1",
    knowledge_space_id: "ks-sales",
    display_name: "销售 FAQ.md",
    source_type: "file",
    file_name: "faq.md",
    file_type: "text/markdown",
    file_size: 64,
    storage_key: "documents/faq.md",
    status: "ready",
    text_chars: 42,
  },
];
const DOCUMENT_BINDINGS = [
  {
    id: "binding-doc-1",
    tenant_id: "t1",
    knowledge_space_id: "ks-sales",
    document_id: "doc-ready",
    employee_id: "e1",
    rag_document_id: "rag-1",
    status: "ready",
  },
];
const DELETE_OPERATION = {
  operation_id: "op-delete",
  operation: "delete",
  idempotency_key: "idem-delete",
  tenant_id: "t1",
  knowledge_space_id: "ks-sales",
  document_id: "doc-ready",
  status: "pending",
  document_status: "deleting",
  upstream_status: "deletion_started",
};
const RECONCILE_PENDING_OPERATION = {
  ...DELETE_OPERATION,
  document_id: "doc-deleting",
  status: "pending",
  document_status: "deleting",
  upstream_status: "present",
};
const RECONCILE_COMPLETED_OPERATION = {
  ...RECONCILE_PENDING_OPERATION,
  status: "completed",
  document_status: "deleted",
  upstream_status: "deleted",
};
const REINDEX_OPERATION = {
  operation_id: "op-reindex",
  operation: "reindex",
  idempotency_key: "idem-reindex",
  tenant_id: "t1",
  knowledge_space_id: "ks-sales",
  document_id: "doc-ready",
  status: "completed",
  document_status: "ready",
  upstream_status: "processed",
};
const LIFECYCLE_DOCUMENTS = [
  ...DOCUMENTS,
  {
    ...DOCUMENTS[1],
    id: "doc-reindex-requested",
    display_name: "待重建.md",
    status: "reindex_requested" as const,
  },
  {
    ...DOCUMENTS[1],
    id: "doc-deleting",
    display_name: "删除中.md",
    status: "deleting" as const,
  },
  {
    ...DOCUMENTS[1],
    id: "doc-deleted",
    display_name: "已删除.md",
    status: "deleted" as const,
  },
];
const REVOKED_DOCUMENT_BINDINGS = [{
  id: "binding-revoked",
  tenant_id: "t1",
  knowledge_space_id: "ks-sales",
  document_id: "doc-ready",
  employee_id: "e1",
  rag_document_id: "rag-revoked",
  status: "revoked" as const,
}];

interface ClientOverrides {
  listGet?: (url: string) => unknown;
  post?: (url: string, options?: unknown) => unknown;
  del?: (url: string) => unknown;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", managerMessages["zh-CN"]!);
  return i18n;
}

function sessionValue(roles: string[] = ["owner"], onUnauthorized: () => void = () => {}): SessionContextValue {
  const session = {
    principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles: ["owner"] },
    claims: { user_id: "u1", tenant_id: "t1", roles, exp: Math.floor(Date.now() / 1000) + 3600 },
  } as AuthSession;
  return { session, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized };
}

function defaultListGet(url: string) {
  if (url === "/api/manager/knowledge-spaces") return { items: SPACES, page: PAGE };
  if (url.includes("/documents/") && url.endsWith("/bindings")) return { items: DOCUMENT_BINDINGS, page: PAGE };
  if (url.endsWith("/bindings")) return { items: BINDINGS, page: PAGE };
  if (url.endsWith("/documents")) return { items: DOCUMENTS, page: PAGE };
  if (url.endsWith("/employees")) return EMPLOYEES;
  if (url.endsWith("/departments")) return DEPARTMENTS;
  if (url.endsWith("/members")) return MEMBERS;
  return { items: [], page: PAGE };
}

function makeClient(overrides: ClientOverrides = {}) {
  const client = {
    get: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    listGet: vi.fn((url: string) => overrides.listGet?.(url) ?? defaultListGet(url)),
    post: vi.fn((url: string, options?: unknown) => overrides.post?.(url, options) ?? (url.endsWith("/reconcile-delete") ? RECONCILE_PENDING_OPERATION : url.endsWith("/reindex") ? REINDEX_OPERATION : null)),
    del: vi.fn((url: string) => overrides.del?.(url) ?? (url.includes("/documents/") ? DELETE_OPERATION : undefined)),
  };
  vi.spyOn(clientMod, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
  return client;
}

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue()}>
        <MemoryRouter>{children}</MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>
  );
}

function renderPage() {
  return render(<KnowledgePage />, { wrapper: Providers });
}

describe("KnowledgePage Astryx contract", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("renders inline enterprise documents and explicit loading, error, and empty states", async () => {
    const pending = deferred<{ items: typeof SPACES; page: typeof PAGE }>();
    makeClient({ listGet: (url) => url === "/api/manager/knowledge-spaces" ? pending.promise : defaultListGet(url) });
    const view = renderPage();
    expect(screen.getByRole("status", { name: "正在加载企业知识库" })).toBeTruthy();

    await act(async () => pending.resolve({ items: [], page: PAGE }));
    expect(await screen.findByText("企业知识库尚未初始化")).toBeTruthy();
    view.unmount();

    makeClient({ listGet: (url) => {
      if (url === "/api/manager/knowledge-spaces") throw new Error("offline");
      return defaultListGet(url);
    } });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("加载企业知识库失败");
  });

  it("renders unauthorized API failures", async () => {
    makeClient({ listGet: (url) => {
      if (url === "/api/manager/knowledge-spaces") throw new ApiError("登录已过期", 401, "unauthorized");
      return defaultListGet(url);
    } });
    render(<KnowledgePage />, { wrapper: ({ children }) => (
      <I18nContext.Provider value={makeI18n()}>
        <SessionContext.Provider value={sessionValue(["member"])}>
          <MemoryRouter>{children}</MemoryRouter>
        </SessionContext.Provider>
      </I18nContext.Provider>
    ) });
    expect(await screen.findByRole("alert")).toHaveTextContent("登录已过期");
  });

  it("只展示企业知识库，不暴露空间 CRUD", async () => {
    makeClient();
    renderPage();
    await screen.findByRole("table", { name: "文档列表" });
    expect(screen.getByTestId("embedded-documents-panel")).toBeInTheDocument();
    expect(screen.getAllByText("企业知识库").length).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog", { name: "文档摄入 · 企业知识库" })).toBeNull();
    expect(screen.queryByRole("button", { name: "新建知识空间" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除企业知识库" })).toBeNull();
    expect(screen.getByRole("link", { name: "打开 LightRAG 控制台" })).toHaveAttribute("href", "http://localhost:9621/webui/");
    expect(screen.getByRole("link", { name: "打开 LightRAG 控制台" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "打开 LightRAG 控制台" })).toHaveAttribute("title", expect.stringContaining("LIGHTRAG_AUTH_ACCOUNTS"));
  });

  it("shows enterprise documents inline and supports URL import, upload, and retry", async () => {
    const client = makeClient();
    renderPage();
    expect(await screen.findByRole("table", { name: "文档列表" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "文档摄入 · 企业知识库" })).toBeNull();
    expect(screen.getByText("销售手册.pdf")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: /URL/ }), { target: { value: "https://example.com/guide" } });
    fireEvent.submit(screen.getByRole("form", { name: "从 URL 导入" }));
    await waitFor(() => expect(client.post).toHaveBeenCalledWith(
      "/api/manager/knowledge-spaces/enterprise_shared/documents/url",
      { body: { url: "https://example.com/guide" } },
    ));

    const file = new File(["hello"], "guide.txt", { type: "text/plain" });
    const uploadForm = screen.getByRole("form", { name: "上传文件" });
    const fileInput = uploadForm.querySelector('input[type="file"]')!;
    await waitFor(() => expect(fileInput).not.toBeDisabled());
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.submit(uploadForm);
    await waitFor(() => expect(client.post).toHaveBeenCalledWith(
      "/api/manager/knowledge-spaces/enterprise_shared/documents",
      expect.objectContaining({ body: expect.any(FormData) }),
    ));

    fireEvent.click(screen.getByRole("button", { name: "重试销售手册.pdf" }));
    await waitFor(() => expect(client.post).toHaveBeenCalledWith(
      "/api/manager/knowledge-spaces/enterprise_shared/documents/doc-failed/reindex",
      { idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    ));
  });

  it("自动刷新处理中间状态，直到文档就绪", async () => {
    vi.useFakeTimers();
    let documentLoads = 0;
    const processing = { ...DOCUMENTS[1], id: "doc-processing", display_name: "处理中.md", status: "parsing" as const };
    const ready = { ...processing, status: "ready" as const };
    const client = makeClient({
      listGet: (url) => {
        if (url.endsWith("/documents")) {
          documentLoads += 1;
          return { items: [documentLoads === 1 ? processing : ready], page: PAGE };
        }
        return defaultListGet(url);
      },
    });
    render(<DocumentsPanel spaceId="ks-sales" spaceName="销售知识库" canWrite onClose={() => {}} />, { wrapper: Providers });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByLabelText("文档状态：解析中")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByLabelText("文档状态：已就绪")).toBeTruthy();
    expect(documentLoads).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
    expect(client.listGet).toHaveBeenCalled();
  });

  it("shows ready and failed status and rebuilds ready indexes", async () => {
    const client = makeClient();
    render(<DocumentsPanel spaceId="ks-sales" spaceName="销售知识库" canWrite onClose={() => {}} />, { wrapper: Providers });
    expect(await screen.findByText("销售 FAQ.md")).toBeTruthy();
    expect(screen.getByText("已就绪")).toBeTruthy();
    expect(screen.getByText("失败")).toBeTruthy();
    expect(screen.getByText(/企业知识库已就绪/)).toBeTruthy();
    expect(screen.getByLabelText(/引用状态：引用可用/)).toBeTruthy();
    expect(screen.getByText("引用不可用")).toBeTruthy();
    expect(screen.getAllByText(/通过 Agent Pi knowledge_get 获取/).length).toBeGreaterThan(0);
    expect(client.get).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "重建索引销售 FAQ.md" }));
    await waitFor(() => expect(client.post).toHaveBeenCalledWith(
      "/api/manager/knowledge-spaces/ks-sales/documents/doc-ready/reindex",
      { idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    ));

    expect(screen.getByRole("button", { name: "删除销售 FAQ.md" })).toBeTruthy();

  });

  it("confirms document deletion, sends the lifecycle request, and shows pending acceptance", async () => {
    const client = makeClient();
    render(<DocumentsPanel spaceId="ks-sales" spaceName="销售知识库" canWrite onClose={() => {}} />, { wrapper: Providers });
    await screen.findByText("销售 FAQ.md");

    fireEvent.click(screen.getByRole("button", { name: "删除销售 FAQ.md" }));
    expect(screen.getByRole("alertdialog", { name: "删除文档" })).toBeTruthy();
    expect(client.del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(client.del).toHaveBeenCalledWith(
      "/api/manager/knowledge-spaces/ks-sales/documents/doc-ready",
      { idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    ));
    expect(await screen.findByText("删除请求已接受，处理中")).toBeTruthy();
  });

  it("checks a deleting document, keeps pending state visible, and reloads completion", async () => {
    const deleting = { ...DOCUMENTS[1], id: "doc-deleting", display_name: "删除中.md", status: "deleting" as const };
    const deleted = { ...deleting, status: "deleted" as const };
    let documentLoads = 0;
    const operations = [RECONCILE_PENDING_OPERATION, RECONCILE_COMPLETED_OPERATION];
    const client = makeClient({
      listGet: (url) => {
        if (url.endsWith("/documents")) {
          documentLoads += 1;
          return { items: [documentLoads >= 3 ? deleted : deleting], page: PAGE };
        }
        return defaultListGet(url);
      },
      post: (url) => url.endsWith("/reconcile-delete") ? operations.shift()! : undefined,
    });
    render(<DocumentsPanel spaceId="ks-sales" spaceName="销售知识库" canWrite onClose={() => {}} />, { wrapper: Providers });

    const checkButton = await screen.findByRole("button", { name: "检查删除状态删除中.md" });
    fireEvent.click(checkButton);
    await waitFor(() => expect(client.post).toHaveBeenCalledWith(
      "/api/manager/knowledge-spaces/ks-sales/documents/doc-deleting/reconcile-delete",
      { idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    ));
    expect(await screen.findByText("删除仍在处理中")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "检查删除状态删除中.md" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "检查删除状态删除中.md" }));
    await waitFor(() => expect(client.post).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText("文档状态：已删除")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "检查删除状态删除中.md" })).toBeNull();
  });

  it("automatically retries deleting documents and marks them deleted after reconciliation", async () => {
    vi.useFakeTimers();
    let documentLoads = 0;
    let reconcileCalls = 0;
    const deleting = { ...DOCUMENTS[1], id: "doc-deleting", display_name: "删除中.md", status: "deleting" as const };
    const deleted = { ...deleting, status: "deleted" as const };
    const client = makeClient({
      listGet: (url) => {
        if (url.endsWith("/documents")) {
          documentLoads += 1;
          return { items: [reconcileCalls > 0 ? deleted : deleting], page: PAGE };
        }
        return defaultListGet(url);
      },
      post: (url) => {
        if (url.endsWith("/reconcile-delete")) {
          reconcileCalls += 1;
          return { ...RECONCILE_COMPLETED_OPERATION, document_id: "doc-deleting" };
        }
        return undefined;
      },
    });
    render(<DocumentsPanel spaceId="ks-sales" spaceName="销售知识库" canWrite onClose={() => {}} />, { wrapper: Providers });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByLabelText("文档状态：删除处理中")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reconcileCalls).toBe(1);
    expect(documentLoads).toBeGreaterThanOrEqual(2);
    expect(screen.getByLabelText("文档状态：已删除")).toBeTruthy();
    vi.useRealTimers();
  });

  it("treats a busy deletion as pending and keeps hard failures retryable", async () => {
    const problems = [
      new ApiError("fallback", 409, "knowledge_deletion_busy", {
        type: "about:blank", title: "busy", status: 409, code: "knowledge_deletion_busy", detail: "LightRAG 删除仍在处理中",
      }),
      new ApiError("fallback", 503, "manager_unavailable", {
        type: "about:blank", title: "unavailable", status: 503, code: "manager_unavailable", detail: "知识索引服务暂不可用",
      }),
    ];
    const client = makeClient({ del: () => { throw problems.shift()!; } });
    render(<DocumentsPanel spaceId="ks-sales" spaceName="销售知识库" canWrite onClose={() => {}} />, { wrapper: Providers });
    await screen.findByText("销售 FAQ.md");

    fireEvent.click(screen.getByRole("button", { name: "删除销售 FAQ.md" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(await screen.findByText("删除请求已接受，LightRAG 正忙，系统会自动重试")).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除销售 FAQ.md" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "删除销售 FAQ.md" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("知识索引服务暂不可用；可重试");
    expect(screen.queryByText("已删除")).toBeNull();
  });

  it("shows reconciliation problem details without claiming deletion completed", async () => {
    const deleting = { ...DOCUMENTS[1], id: "doc-deleting", display_name: "删除中.md", status: "deleting" as const };
    const problems = [
      new ApiError("fallback", 409, "knowledge_deletion_busy", {
        type: "about:blank", title: "busy", status: 409, code: "knowledge_deletion_busy", detail: "LightRAG 删除仍在处理中",
      }),
      new ApiError("fallback", 503, "knowledge_upstream_unavailable", {
        type: "about:blank", title: "unavailable", status: 503, code: "knowledge_upstream_unavailable", detail: "知识索引服务暂不可用",
      }),
    ];
    const client = makeClient({
      listGet: (url) => url.endsWith("/documents") ? { items: [deleting], page: PAGE } : defaultListGet(url),
      post: (url) => url.endsWith("/reconcile-delete") ? (() => { throw problems.shift()!; })() : undefined,
    });
    render(<DocumentsPanel spaceId="ks-sales" spaceName="销售知识库" canWrite onClose={() => {}} />, { wrapper: Providers });

    const checkButton = await screen.findByRole("button", { name: "检查删除状态删除中.md" });
    fireEvent.click(checkButton);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("LightRAG 删除仍在处理中；可重试"));
    expect(screen.getByRole("button", { name: "检查删除状态删除中.md" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "检查删除状态删除中.md" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("知识索引服务暂不可用；可重试"));
    expect(screen.queryByText("删除已完成")).toBeNull();
    expect(screen.getByLabelText("文档状态：删除处理中")).toBeTruthy();
  });

  it("renders lifecycle statuses and hides deleted citations", async () => {
    makeClient({ listGet: (url) => {
      if (url.endsWith("/documents")) return { items: LIFECYCLE_DOCUMENTS, page: PAGE };
      return defaultListGet(url);
    } });
    render(<DocumentsPanel spaceId="ks-sales" spaceName="销售知识库" canWrite onClose={() => {}} />, { wrapper: Providers });

    expect(await screen.findByText("删除中.md")).toBeTruthy();
    expect(screen.getAllByText("删除处理中").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已删除").length).toBeGreaterThan(0);
    expect(screen.getByText("重建索引中")).toBeTruthy();
    expect(screen.getByRole("button", { name: "检查删除状态删除中.md" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除删除中.md" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除已删除.md" })).toBeNull();

  });

  it("keeps enterprise admins writable while citation content stays out of Manager HTTP", async () => {
    const client = makeClient();
    render(<KnowledgePage />, { wrapper: ({ children }) => (
      <I18nContext.Provider value={makeI18n()}>
        <SessionContext.Provider value={sessionValue(["enterprise_admin"])}>
          <MemoryRouter>{children}</MemoryRouter>
        </SessionContext.Provider>
      </I18nContext.Provider>
    ) });
    await screen.findByRole("table", { name: "文档列表" });
    expect(screen.queryByRole("dialog", { name: "文档摄入 · 企业知识库" })).toBeNull();
    expect(screen.getByRole("form", { name: "上传文件" })).toBeTruthy();
    expect(screen.getByRole("form", { name: "从 URL 导入" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除销售手册.pdf" })).toBeTruthy();
    expect(client.get).not.toHaveBeenCalled();
    expect(client.listGet.mock.calls.flat().some((url) => String(url).includes("citation") || String(url).includes("/rag"))).toBe(false);
  });

  it("shows explicit document loading, empty, and error states", async () => {
    const pending = deferred<{ items: never[]; page: typeof PAGE }>();
    makeClient({ listGet: (url) => url.endsWith("/documents") ? pending.promise : defaultListGet(url) });
    const view = render(<DocumentsPanel spaceId="ks-sales" spaceName="销售知识库" canWrite onClose={() => {}} />, { wrapper: Providers });
    expect(screen.getByRole("status", { name: "正在加载文档" })).toBeTruthy();
    await act(async () => pending.resolve({ items: [], page: PAGE }));
    expect(await screen.findByText("暂无文档")).toBeTruthy();
    view.unmount();

    makeClient({ listGet: (url) => {
      if (url.endsWith("/documents")) throw new Error("offline");
      return defaultListGet(url);
    } });
    render(<DocumentsPanel spaceId="ks-sales" spaceName="销售知识库" canWrite onClose={() => {}} />, { wrapper: Providers });
    expect(await screen.findByRole("alert")).toHaveTextContent("加载文档失败");
  });

  it("renders LightRAG analytics cards and a document detail drawer", async () => {
    const analytics = {
      knowledge_space_id: "enterprise_shared", status: "available" as const,
      document_count: 2, ready_count: 1, failed_count: 1, processing_count: 0, deleted_count: 0,
      total_bytes: 2048, total_text_chars: 800, total_chunks: 4,
      upstream_document_count: 2, upstream_ready_count: 1,
      upstream_failed_count: 1, upstream_processing_count: 0,
      last_activity_at: "2026-08-26T00:00:00Z", refreshed_at: "2026-08-26T00:00:00Z",
      daily_activity: [{ date: "2026-08-26", activity_count: 2, documents_created: 1, documents_updated: 0, ingestions: 1, ready: 1, failed: 0 }],
      documents: [{
        document_id: "doc-ready", display_name: "销售 FAQ.md", source_type: "file" as const,
        file_name: "faq.md", file_type: "text/markdown", file_size: 64, text_chars: 42, chunk_count: 4,
        status: "ready" as const, ingestion_status: "done", upstream_status: "processed", error_code: null,
        binding_count: 1, ready_binding_count: 1, stale_binding_count: 0, revoked_binding_count: 0, pending_binding_count: 0,
        ingestion_started_at: null, ingestion_completed_at: null, created_at: null, updated_at: null,
      }],
    };
    const client = makeClient({ listGet: (url) => url.endsWith("/analytics") ? { items: [analytics], page: PAGE } : defaultListGet(url) });
    renderPage();
    expect(await screen.findByLabelText("文档摄入统计")).toBeTruthy();
    expect(screen.getByText("2 个")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "查看详情销售 FAQ.md" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看详情销售 FAQ.md" }));
    expect(await screen.findByRole("dialog", { name: "文档详情 · 销售 FAQ.md" })).toBeTruthy();
    expect(screen.getByText(/分块：4/)).toBeTruthy();
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/knowledge-spaces/enterprise_shared/analytics");
  });

  it("keeps member access read-only and does not expose write controls", async () => {
    makeClient();
    render(<KnowledgePage />, { wrapper: ({ children }) => (
      <I18nContext.Provider value={makeI18n()}>
        <SessionContext.Provider value={sessionValue(["member"])}>
          <MemoryRouter>{children}</MemoryRouter>
        </SessionContext.Provider>
      </I18nContext.Provider>
    ) });
    await screen.findByRole("table", { name: "文档列表" });
    expect(screen.queryByRole("button", { name: "新建知识空间" })).toBeNull();
    expect(screen.queryByRole("link", { name: "打开 LightRAG 控制台" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "文档摄入 · 企业知识库" })).toBeNull();
    expect(screen.queryByRole("form", { name: "上传文件" })).toBeNull();
    expect(screen.queryByRole("form", { name: "从 URL 导入" })).toBeNull();
    expect(screen.queryByRole("button", { name: /重试|重建索引/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /删除销售手册\.pdf/ })).toBeNull();
    expect(screen.getByText(/引用正文不通过 Manager HTTP 页面加载/)).toBeTruthy();
  });

});

describe("S05 persisted ingestion recovery consumer", () => {
  afterEach(() => vi.restoreAllMocks());
  it("unknown failed submissions stay polled with retry/delete protected, then recover to ready", async () => {
    let unknown = true;
    const timer = vi.spyOn(window, "setInterval");
    const client = makeClient({ listGet: (url) => url.endsWith("/documents") ? { items: [{ ...DOCUMENTS[1],
      status: unknown ? "failed" : "ready", error_code: unknown ? "SUBMISSION_UNKNOWN" : null,
      can_retry: !unknown, can_delete: !unknown,
    }], page: PAGE } : undefined });
    render(<DocumentsPanel embedded canWrite spaceId="ks-sales" spaceName="Fixture" onClose={() => {}} />, { wrapper: Providers });
    expect(await screen.findByText(/需对账：提交结果未知/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /重试销售 FAQ/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /删除销售 FAQ/ })).not.toBeInTheDocument();
    expect(client.post).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
    const polling = timer.mock.calls.find(([, milliseconds]) => milliseconds === 2000)?.[0];
    expect(typeof polling).toBe("function");
    unknown = false;
    await act(async () => { if (typeof polling === "function") polling(); });
    expect(await screen.findByRole("button", { name: "重建索引销售 FAQ.md" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除销售 FAQ.md" })).toBeInTheDocument();
    expect(screen.queryByText(/需对账：提交结果未知/)).not.toBeInTheDocument();
  });
});

describe("S05 unknown operation response", () => {
  afterEach(() => vi.restoreAllMocks());
  it("keeps a failed SUBMISSION_UNKNOWN operation protected while ordinary failed documents remain retryable", async () => {
    let unknown = false;
    const client = makeClient({
      listGet: (url) => url.endsWith("/documents") ? { items: [{ ...DOCUMENTS[1], status: unknown ? "failed" : "ready",
        error_code: unknown ? "SUBMISSION_UNKNOWN" : null, can_retry: !unknown, can_delete: !unknown }], page: PAGE } : undefined,
      post: () => {
        unknown = true;
        return { ...REINDEX_OPERATION, status: "failed", error_code: "SUBMISSION_UNKNOWN" };
      },
    });
    render(<DocumentsPanel embedded canWrite spaceId="ks-sales" spaceName="Fixture" />, { wrapper: Providers });
    fireEvent.click(await screen.findByRole("button", { name: "重建索引销售 FAQ.md" }));
    expect(await screen.findByText("需对账：提交结果未知，重试与删除保持保护；自动检查中。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重建索引销售 FAQ.md" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除销售 FAQ.md" })).not.toBeInTheDocument();
    expect(screen.queryByText(/；可重试/)).not.toBeInTheDocument();
    expect(client.post).toHaveBeenCalledTimes(1);
  });
});

describe("S05 stale document action", () => {
  afterEach(() => vi.restoreAllMocks());
  it("re-reads capabilities after a reconciliation-required conflict without advertising retry", async () => {
    let unknown = false;
    makeClient({
      listGet: (url) => url.endsWith("/documents") ? { items: [{ ...DOCUMENTS[1], status: unknown ? "failed" : "ready",
        error_code: unknown ? "SUBMISSION_UNKNOWN" : null, can_retry: !unknown, can_delete: !unknown }], page: PAGE } : undefined,
      post: () => {
        unknown = true;
        throw new ApiError("Needs reconciliation", 409, "knowledge_reconciliation_required", {
          type: "about:blank", title: "Needs reconciliation", status: 409, code: "knowledge_reconciliation_required", detail: "Outcome unknown",
        });
      },
    });
    render(<DocumentsPanel embedded canWrite spaceId="ks-sales" spaceName="Fixture" />, { wrapper: Providers });
    fireEvent.click(await screen.findByRole("button", { name: "重建索引销售 FAQ.md" }));
    expect(await screen.findByText("提交结果未知，需对账；当前不能重试或删除")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试销售 FAQ.md" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除销售 FAQ.md" })).not.toBeInTheDocument();
    expect(screen.queryByText(/；可重试/)).not.toBeInTheDocument();
  });
});
