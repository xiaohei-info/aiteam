import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  { knowledge_space_id: "ks-sales", workspace: "ws1", display_name: "销售知识库" },
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
    post: vi.fn((url: string, options?: unknown) => overrides.post?.(url, options) ?? null),
    del: vi.fn((url: string) => overrides.del?.(url)),
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
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders a named knowledge-space table and explicit loading, error, and empty states", async () => {
    const pending = deferred<{ items: typeof SPACES; page: typeof PAGE }>();
    makeClient({ listGet: (url) => url === "/api/manager/knowledge-spaces" ? pending.promise : defaultListGet(url) });
    const view = renderPage();
    expect(screen.getByRole("status", { name: "正在加载知识空间" })).toBeTruthy();

    await act(async () => pending.resolve({ items: [], page: PAGE }));
    expect(await screen.findByText("暂无知识空间")).toBeTruthy();
    view.unmount();

    makeClient({ listGet: (url) => {
      if (url === "/api/manager/knowledge-spaces") throw new Error("offline");
      return defaultListGet(url);
    } });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("加载失败");
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

  it("creates a knowledge space and confirms deletion before calling the API", async () => {
    const client = makeClient();
    renderPage();
    await screen.findByRole("table", { name: "知识空间" });

    fireEvent.click(screen.getByRole("button", { name: "新建知识空间" }));
    const createDialog = screen.getByRole("dialog", { name: "新建知识空间" });
    fireEvent.change(screen.getByRole("textbox", { name: /知识空间 ID/ }), { target: { value: "ks-ops" } });
    fireEvent.change(screen.getByRole("textbox", { name: /显示名称/ }), { target: { value: "运营知识库" } });
    fireEvent.submit(createDialog.querySelector("form")!);
    await waitFor(() => expect(client.post).toHaveBeenCalledWith(
      "/api/manager/knowledge-spaces",
      { body: { knowledge_space_id: "ks-ops", display_name: "运营知识库" } },
    ));

    fireEvent.click(screen.getByRole("button", { name: "删除销售知识库" }));
    expect(screen.getByRole("alertdialog", { name: "删除知识空间" })).toBeTruthy();
    expect(client.del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(client.del).toHaveBeenCalledWith("/api/manager/knowledge-spaces/ks-sales"));
  });

  it("uses named binding UI, preserves payloads, and confirms unbinding", async () => {
    const client = makeClient();
    renderPage();
    await screen.findByRole("table", { name: "知识空间" });
    fireEvent.click(screen.getByRole("button", { name: "管理销售知识库绑定" }));

    expect(await screen.findByRole("dialog", { name: "绑定管理 · 销售知识库" })).toBeTruthy();
    expect(await screen.findByRole("table", { name: "当前绑定" })).toBeTruthy();
    const form = screen.getByRole("form", { name: "新增绑定" });
    fireEvent.click(screen.getByRole("combobox", { name: /绑定对象/ }));
    fireEvent.click(await screen.findByRole("option", { name: "张三" }));
    fireEvent.submit(form);
    await waitFor(() => expect(client.post).toHaveBeenCalledWith(
      "/api/manager/knowledge-spaces/ks-sales/bindings",
      { body: { knowledge_space_id: "ks-sales", resource_type: "expert", resource_id: "e1" } },
    ));

    fireEvent.click(screen.getByRole("button", { name: "解绑张三" }));
    expect(screen.getByRole("alertdialog", { name: "解除知识绑定" })).toBeTruthy();
    expect(client.del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认解绑" }));
    await waitFor(() => expect(client.del).toHaveBeenCalledWith("/api/manager/knowledge-spaces/ks-sales/bindings/expert/e1"));
  });

  it("does not let an older binding request overwrite the newly selected space", async () => {
    const first = deferred<{ items: typeof BINDINGS; page: typeof PAGE }>();
    const secondBindings = [{ ...BINDINGS[0]!, id: "member:m1:ks-support", knowledge_space_id: "ks-support", resource_type: "member", resource_id: "m1" }];
    const second = deferred<{ items: typeof secondBindings; page: typeof PAGE }>();
    makeClient({ listGet: (url) => {
      if (url === "/api/manager/knowledge-spaces") {
        return { items: [...SPACES, { knowledge_space_id: "ks-support", workspace: "ws2", display_name: "客服知识库" }], page: PAGE };
      }
      if (url.includes("ks-sales/bindings")) return first.promise;
      if (url.includes("ks-support/bindings")) return second.promise;
      return defaultListGet(url);
    } });
    renderPage();
    await screen.findByRole("table", { name: "知识空间" });

    fireEvent.click(screen.getByRole("button", { name: "管理销售知识库绑定" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "绑定管理 · 销售知识库" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "管理客服知识库绑定" }));
    await act(async () => second.resolve({ items: secondBindings, page: PAGE }));
    expect(await screen.findByText("李四")).toBeTruthy();
    await act(async () => first.resolve({ items: BINDINGS, page: PAGE }));

    expect(screen.getByRole("dialog", { name: "绑定管理 · 客服知识库" })).toBeTruthy();
    const currentBindings = screen.getByRole("table", { name: "当前绑定" });
    expect(within(currentBindings).queryByText("张三")).toBeNull();
    expect(within(currentBindings).getByText("李四")).toBeTruthy();
  });

  it("loads a named document dialog and supports URL import, upload, and retry", async () => {
    const client = makeClient();
    renderPage();
    await screen.findByRole("table", { name: "知识空间" });
    fireEvent.click(screen.getByRole("button", { name: "管理销售知识库文档" }));

    expect(await screen.findByRole("dialog", { name: "文档摄入 · 销售知识库" })).toBeTruthy();
    expect(await screen.findByRole("table", { name: "文档列表" })).toBeTruthy();
    expect(screen.getByText("销售手册.pdf")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: /URL/ }), { target: { value: "https://example.com/guide" } });
    fireEvent.submit(screen.getByRole("form", { name: "从 URL 导入" }));
    await waitFor(() => expect(client.post).toHaveBeenCalledWith(
      "/api/manager/knowledge-spaces/ks-sales/documents/url",
      { body: { url: "https://example.com/guide" } },
    ));

    const file = new File(["hello"], "guide.txt", { type: "text/plain" });
    const uploadForm = screen.getByRole("form", { name: "上传文件" });
    const fileInput = uploadForm.querySelector('input[type="file"]')!;
    await waitFor(() => expect(fileInput).not.toBeDisabled());
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.submit(uploadForm);
    await waitFor(() => expect(client.post).toHaveBeenCalledWith(
      "/api/manager/knowledge-spaces/ks-sales/documents",
      expect.objectContaining({ body: expect.any(FormData) }),
    ));

    fireEvent.click(screen.getByRole("button", { name: "重试销售手册.pdf" }));
    await waitFor(() => expect(client.post).toHaveBeenCalledWith("/api/manager/knowledge-spaces/ks-sales/documents/doc-failed/retry"));
  });

  it("shows ready and failed status, rebuilds ready indexes, and projects binding status", async () => {
    const client = makeClient();
    render(<DocumentsPanel spaceId="ks-sales" spaceName="销售知识库" canWrite onClose={() => {}} />, { wrapper: Providers });
    expect(await screen.findByText("销售 FAQ.md")).toBeTruthy();
    expect(screen.getByText("完成")).toBeTruthy();
    expect(screen.getByText("失败")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重建索引销售 FAQ.md" }));
    await waitFor(() => expect(client.post).toHaveBeenCalledWith("/api/manager/knowledge-spaces/ks-sales/documents/doc-ready/retry"));

    fireEvent.click(screen.getByRole("button", { name: "查看销售 FAQ.md绑定状态" }));
    expect(await screen.findByRole("dialog", { name: "索引绑定 · 销售 FAQ.md" })).toBeTruthy();
    expect(await screen.findByText("已就绪")).toBeTruthy();
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

  it("keeps member access read-only and does not expose write controls", async () => {
    makeClient();
    render(<KnowledgePage />, { wrapper: ({ children }) => (
      <I18nContext.Provider value={makeI18n()}>
        <SessionContext.Provider value={sessionValue(["member"])}>
          <MemoryRouter>{children}</MemoryRouter>
        </SessionContext.Provider>
      </I18nContext.Provider>
    ) });
    await screen.findByRole("table", { name: "知识空间" });
    expect(screen.queryByRole("button", { name: "新建知识空间" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "管理销售知识库文档" }));
    expect(await screen.findByRole("dialog", { name: "文档摄入 · 销售知识库" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "上传文件" })).toBeNull();
    expect(screen.queryByRole("form", { name: "从 URL 导入" })).toBeNull();
  });

  it("does not let an older document request overwrite a new space", async () => {
    const first = deferred<{ items: typeof DOCUMENTS; page: typeof PAGE }>();
    const supportDocs = [{ ...DOCUMENTS[0]!, id: "doc-support", knowledge_space_id: "ks-support", display_name: "客服手册.md", status: "ready" as const }];
    const second = deferred<{ items: typeof supportDocs; page: typeof PAGE }>();
    makeClient({ listGet: (url) => {
      if (url.includes("ks-sales/documents")) return first.promise;
      if (url.includes("ks-support/documents")) return second.promise;
      return defaultListGet(url);
    } });
    const view = render(<DocumentsPanel spaceId="ks-sales" spaceName="销售知识库" canWrite onClose={() => {}} />, { wrapper: Providers });
    view.rerender(<DocumentsPanel spaceId="ks-support" spaceName="客服知识库" canWrite onClose={() => {}} />);
    await act(async () => second.resolve({ items: supportDocs, page: PAGE }));
    expect(await screen.findByText("客服手册.md")).toBeTruthy();
    await act(async () => first.resolve({ items: DOCUMENTS, page: PAGE }));
    expect(screen.queryByText("销售手册.pdf")).toBeNull();
    expect(screen.getByText("客服手册.md")).toBeTruthy();
  });
});
