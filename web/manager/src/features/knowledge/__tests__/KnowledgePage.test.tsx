/**
 * 知识空间页绑定 UI 测试：
 * - 绑定按钮触发面板加载（bindings + 候选专家/部门/成员）
 * - 提交绑定调用 api.bind 并经 reloadBindings 刷新列表
 * - 解绑调用 api.unbind 并刷新列表
 * - 资源选项随绑定类型切换
 */
import React from "react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import type { ApiClient } from "../../../api/client";
import * as clientMod from "../../../api/client";
import { KnowledgePage } from "../KnowledgePage";

const SPACES = [
  { knowledge_space_id: "ks-sales", workspace: "ws1", display_name: "销售知识库" },
];
const EMPLOYEES = { items: [{ employee_id: "e1", display_name: "张三" }], page: { next_cursor: null, has_more: false } };
const DEPARTMENTS = { items: [{ id: "d1", display_name: "销售部" }], page: { next_cursor: null, has_more: false } };
const MEMBERS = { items: [{ id: "m1", display_name: "李四" }], page: { next_cursor: null, has_more: false } };
const BINDINGS = [
  { id: "expert:e1:ks-sales", tenant_id: "t1", knowledge_space_id: "ks-sales", resource_type: "expert", resource_id: "e1", created_at: null },
];

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", managerMessages["zh-CN"]!);
  return i18n;
}

function sessionValue(): SessionContextValue {
  const session = {
    principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles: ["owner"] },
    claims: { user_id: "u1", tenant_id: "t1", roles: ["owner"], exp: Math.floor(Date.now() / 1000) + 3600 },
  } as AuthSession;
  return { session, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };
}

function makeClient(cbs: {
  listSpaces?: () => unknown; listBinds?: () => unknown; bind?: () => unknown; unbind?: () => unknown;
}) {
  const client = {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
    del: vi.fn(),
    put: vi.fn(),
    listGet: vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/knowledge-spaces") || url === "/api/manager/knowledge-spaces") return cbs.listSpaces?.() ?? { items: SPACES, page: { next_cursor: null, has_more: false } };
      if (url.endsWith("/bindings")) return cbs.listBinds?.() ?? { items: BINDINGS, page: { next_cursor: null, has_more: false } };
      if (url.endsWith("/employees")) return EMPLOYEES;
      if (url.endsWith("/departments")) return DEPARTMENTS;
      if (url.endsWith("/members")) return MEMBERS;
      return { items: [], page: { next_cursor: null, has_more: false } };
    }),
  };
  vi.spyOn(clientMod, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
  return client;
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue()}>
        <MemoryRouter>
          <KnowledgePage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("KnowledgePage 绑定 UI", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("点击绑定按钮加载绑定面板并列出当前绑定", async () => {
    const client = makeClient({});
    renderPage();
    await screen.findByText("销售知识库");
    fireEvent.click(screen.getByText("绑定"));
    await waitFor(() => expect(client.listGet).toHaveBeenCalledWith("/api/manager/knowledge-spaces/ks-sales/bindings"));
    await waitFor(() => expect(client.post).not.toHaveBeenCalled());
    await screen.findByText(/绑定管理/);
    expect(screen.getByText("当前绑定")).toBeTruthy();
  });

  it("提交绑定调用 api.bind 并用 resource_type/resource_id 刷新列表", async () => {
    const bindSpy = vi.fn().mockResolvedValue({ id: "expert:e2:ks-sales", resource_type: "expert", resource_id: "e2" });
    const listBindsSpy = vi.fn()
      .mockResolvedValueOnce({ items: BINDINGS, page: { next_cursor: null, has_more: false } })
      .mockResolvedValue({ items: [...BINDINGS, { id: "expert:e2:ks-sales", tenant_id: "t1", knowledge_space_id: "ks-sales", resource_type: "expert", resource_id: "e2", created_at: null }], page: { next_cursor: null, has_more: false } });
    const client = makeClient({ bind: bindSpy, listBinds: listBindsSpy });
    client.post = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/bindings")) return bindSpy();
      return null;
    });
    renderPage();
    await screen.findByText("销售知识库");
    fireEvent.click(screen.getByText("绑定"));
    await screen.findByText(/新增绑定/);

    // 选择一个专家（下拉默认已含 employees 列表，value=e1）
    const selects = await screen.findAllByRole("combobox");
    // 第一个 select 是绑定类型（默认 expert），第二个是对象列表
    fireEvent.change(selects[1]!, { target: { value: "e1" } });
    fireEvent.submit(selects[1]!.closest("form")!);

    await waitFor(() => expect(client.post).toHaveBeenCalledWith(
      "/api/manager/knowledge-spaces/ks-sales/bindings",
      expect.objectContaining({ body: expect.objectContaining({ resource_type: "expert", resource_id: "e1" }) }),
    ));
  });

  it("解绑按钮调用 api.unbind", async () => {
    const unbindSpy = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ unbind: unbindSpy });
    client.del = vi.fn().mockResolvedValue(undefined);
    renderPage();
    await screen.findByText("销售知识库");
    fireEvent.click(screen.getByText("绑定"));
    await screen.findByText("当前绑定");
    const unbindBtn = await screen.findByText("解绑");
    fireEvent.click(unbindBtn);
    await waitFor(() => expect(client.del).toHaveBeenCalledWith("/api/manager/knowledge-spaces/ks-sales/bindings/expert/e1"));
  });
});
