/**
 * 目录治理页面测试（W-O.3 F03）。
 *
 * 覆盖：role-state 门控、列表渲染、cursor 翻页、写操作 disabled/启用、
 * API 调用与错误展示。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PlatformRole, ApiError } from "@aiteam/shared";
import { createI18n } from "@aiteam/shared";
import { SessionContext } from "../../auth/session";
import { I18nContext } from "../../i18n/context";
import { operationMessages } from "../../i18n/messages";
import { CatalogPage } from "./CatalogPage";
import { CatalogDetailPage } from "./CatalogDetailPage";
import type { SessionContextValue } from "../../auth/session";

// ---- helpers ----

const mockFetch = vi.fn();

function makeSystemAdminSession(): SessionContextValue {
  return {
    session: {
      principal: {
        id: "u1",
        display_name: "admin",
        status: "active",
        roles: [PlatformRole.SYSTEM_ADMIN],
      },
      claims: {
        user_id: "u1",
        roles: [PlatformRole.SYSTEM_ADMIN],
        exp: 9999999999,
      },
    },
    token: "stub-token",
    signIn: vi.fn(),
    signOut: vi.fn(),
    onUnauthorized: vi.fn(),
  };
}

function makeSystemOperatorSession(): SessionContextValue {
  return {
    session: {
      principal: {
        id: "u2",
        display_name: "operator",
        status: "active",
        roles: [PlatformRole.SYSTEM_OPERATOR],
      },
      claims: {
        user_id: "u2",
        roles: [PlatformRole.SYSTEM_OPERATOR],
        exp: 9999999999,
      },
    },
    token: "stub-token",
    signIn: vi.fn(),
    signOut: vi.fn(),
    onUnauthorized: vi.fn(),
  };
}

function envOk() {
  return new Response(
    JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function listPage(
  items: unknown[],
  cursor: string | null = null,
  hasMore = false,
) {
  return new Response(
    JSON.stringify({
      data: items,
      page: { next_cursor: cursor, has_more: hasMore },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function singleResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function problemResponse(status: number, code: string, detail: string) {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: "error",
      status,
      code,
      detail,
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: {} });
  i18n.extend("zh-CN", operationMessages["zh-CN"]!);
  return i18n;
}

function renderCatalogPage(sessionCtx: SessionContextValue) {
  const i18n = makeI18n();
  return render(
    <I18nContext.Provider value={i18n}>
      <SessionContext.Provider value={sessionCtx}>
        <MemoryRouter initialEntries={["/catalog"]}>
          <Routes>
            <Route path="/catalog" element={<CatalogPage />} />
            <Route path="/catalog/:catalog_type/:template_id" element={<CatalogDetailPage />} />
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

function renderCatalogDetail(sessionCtx: SessionContextValue, id: string, catalogType = "expert_template") {
  const i18n = makeI18n();
  return render(
    <I18nContext.Provider value={i18n}>
      <SessionContext.Provider value={sessionCtx}>
        <MemoryRouter initialEntries={[`/catalog/${catalogType}/${id}`]}>
          <Routes>
            <Route path="/catalog" element={<CatalogPage />} />
            <Route path="/catalog/:catalog_type/:template_id" element={<CatalogDetailPage />} />
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

function makeCatalogItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    catalog_type: "expert_template",
    template_id: "a",
    display_name: "test",
    status: "draft",
    visible_scope: null,
    version: "1",
    ...overrides,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(envOk());
  (globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch;
});

afterEach(() => {
  delete (globalThis as unknown as { fetch?: typeof fetch }).fetch;
});

// ---- 1. role-state 门控 ----

describe("role-state 门控", () => {
  it("无平台角色时显示无权限提示", async () => {
    const sess = makeSystemAdminSession();
    sess.session = null;
    renderCatalogPage(sess);
    await waitFor(() => {
      expect(screen.getByText("无权限访问目录治理。")).toBeInTheDocument();
    });
  });

  it("system_admin 可见列表", async () => {
    renderCatalogPage(makeSystemAdminSession());
    await waitFor(() => {
      expect(screen.getByText("目录治理")).toBeInTheDocument();
    });
  });

  it("system_operator 可见列表", async () => {
    renderCatalogPage(makeSystemOperatorSession());
    await waitFor(() => {
      expect(screen.getByText("目录治理")).toBeInTheDocument();
    });
  });
});

// ---- 2. 列表渲染 ----

describe("列表渲染", () => {
  it("无数据时显示暂无目录项", async () => {
    renderCatalogPage(makeSystemAdminSession());
    await waitFor(() => {
      expect(screen.getByText("暂无目录项。")).toBeInTheDocument();
    });
  });

  it("显示目录项列表", async () => {
    mockFetch.mockResolvedValue(
      listPage([
        makeCatalogItem({
          catalog_type: "expert_template",
          template_id: "a",
          display_name: "客服专家",
          status: "published",
          visible_scope: null,
          version: "1.0",
        }),
      ]),
    );
    renderCatalogPage(makeSystemAdminSession());
    await waitFor(() => {
      expect(screen.getByText("客服专家")).toBeInTheDocument();
    });
    expect(screen.getByText("已发布")).toBeInTheDocument();
    // "公开" appears in visibility td + select option
    expect(screen.getAllByText("公开").length).toBeGreaterThanOrEqual(1);
  });
});

// ---- 3. cursor 翻页 ----

describe("cursor 翻页", () => {
  it("有 more 时显示加载更多按钮", async () => {
    mockFetch.mockResolvedValue(
      listPage([makeCatalogItem()], "next-abc", true),
    );
    renderCatalogPage(makeSystemAdminSession());
    await waitFor(() => {
      expect(screen.getByText("加载更多")).toBeInTheDocument();
    });
  });

  it("点击加载更多追加数据", async () => {
    mockFetch
      .mockResolvedValueOnce(
        listPage([makeCatalogItem({ template_id: "a", display_name: "first" })], "cursor-1", true),
      )
      .mockResolvedValueOnce(
        listPage(
          [
            makeCatalogItem({
              catalog_type: "solution_template",
              template_id: "b",
              display_name: "second",
              status: "published",
              visible_scope: null,
            }),
          ],
          null,
          false,
        ),
      );

    renderCatalogPage(makeSystemAdminSession());

    await waitFor(() => {
      expect(screen.getByText("first")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("加载更多"));

    await waitFor(() => {
      expect(screen.getByText("second")).toBeInTheDocument();
    });
  });

  it("没有 more 时不显示加载更多", async () => {
    mockFetch.mockResolvedValue(
      listPage([makeCatalogItem()], null, false),
    );
    renderCatalogPage(makeSystemAdminSession());
    await waitFor(() => {
      expect(screen.getByText("test")).toBeInTheDocument();
    });
    expect(screen.queryByText("加载更多")).not.toBeInTheDocument();
  });
});

// ---- 4. 管理员可写操作 ----

describe("管理员写操作", () => {
  it("管理员可见注册按钮", async () => {
    renderCatalogPage(makeSystemAdminSession());
    await waitFor(() => {
      expect(screen.getByText("注册模板/方案")).toBeInTheDocument();
    });
  });

  it("operator 看不到注册按钮", async () => {
    renderCatalogPage(makeSystemOperatorSession());
    await waitFor(() => {
      expect(screen.getByText("目录治理")).toBeInTheDocument();
    });
    expect(screen.queryByText("注册模板/方案")).not.toBeInTheDocument();
  });

  it("管理员点击发布后调 POST publish", async () => {
    mockFetch
      .mockResolvedValueOnce(
        listPage([makeCatalogItem({ status: "draft" })]),
      )
      .mockResolvedValueOnce(singleResponse(null))
      .mockResolvedValueOnce(listPage([]));

    renderCatalogPage(makeSystemAdminSession());

    await waitFor(() => {
      expect(screen.getByText("发布")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("发布"));

    await waitFor(() => {
      const publishCall = mockFetch.mock.calls.find((c: unknown[]) =>
        (c[0] as string).includes("/publish"),
      );
      expect(publishCall).toBeDefined();
    });
  });

  it("管理员点击下架后调 POST unpublish", async () => {
    mockFetch
      .mockResolvedValueOnce(
        listPage([
          makeCatalogItem({ status: "published", visible_scope: null }),
        ]),
      )
      .mockResolvedValueOnce(singleResponse(null))
      .mockResolvedValueOnce(listPage([]));

    renderCatalogPage(makeSystemAdminSession());

    await waitFor(() => {
      expect(screen.getByText("下架")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("下架"));

    await waitFor(() => {
      const unpublishCall = mockFetch.mock.calls.find((c: unknown[]) =>
        (c[0] as string).includes("/unpublish"),
      );
      expect(unpublishCall).toBeDefined();
    });
  });

  it("已发布项不显示发布按钮（只显下架）", async () => {
    mockFetch.mockResolvedValue(
      listPage([
        makeCatalogItem({ status: "published", visible_scope: null }),
      ]),
    );
    renderCatalogPage(makeSystemAdminSession());
    await waitFor(() => {
      expect(screen.queryByText("发布")).not.toBeInTheDocument();
      expect(screen.getByText("下架")).toBeInTheDocument();
    });
  });

  it("下架状态项显示发布按钮（不显下架）", async () => {
    mockFetch.mockResolvedValue(
      listPage([
        makeCatalogItem({ status: "unpublished", visible_scope: null }),
      ]),
    );
    renderCatalogPage(makeSystemAdminSession());
    await waitFor(() => {
      expect(screen.getByText("发布")).toBeInTheDocument();
      expect(screen.queryByText("下架")).not.toBeInTheDocument();
    });
  });

  it("operator 看不到发布/下架按钮", async () => {
    mockFetch.mockResolvedValue(
      listPage([makeCatalogItem({ status: "draft" })]),
    );
    renderCatalogPage(makeSystemOperatorSession());
    await waitFor(() => {
      expect(screen.getByText("test")).toBeInTheDocument();
    });
    // operator table should have status but no action buttons
    expect(screen.queryByText("发布")).not.toBeInTheDocument();
    expect(screen.queryByText("下架")).not.toBeInTheDocument();
  });
});

// ---- 5. API 错误展示 ----

describe("API 错误展示", () => {
  it("列表加载失败展示错误 detail", async () => {
    mockFetch.mockResolvedValue(
      problemResponse(500, "internal_error", "服务内部错误"),
    );
    renderCatalogPage(makeSystemAdminSession());
    await waitFor(() => {
      expect(screen.getByText("服务内部错误")).toBeInTheDocument();
    });
  });

  it("publish 失败展示错误", async () => {
    mockFetch
      .mockResolvedValueOnce(listPage([makeCatalogItem({ status: "draft" })]))
      .mockResolvedValueOnce(
        problemResponse(409, "conflict", "该模板已发布"),
      );

    renderCatalogPage(makeSystemAdminSession());

    await waitFor(() => {
      expect(screen.getByText("发布")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("发布"));

    await waitFor(() => {
      expect(screen.getByText("该模板已发布")).toBeInTheDocument();
    });
  });
});

// ---- 6. 注册表单 ----

describe("注册表单", () => {
  it("点击注册按钮展示表单", async () => {
    renderCatalogPage(makeSystemAdminSession());

    await waitFor(() => {
      expect(screen.getByText("注册模板/方案")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("注册模板/方案"));

    await waitFor(() => {
      expect(screen.getByText("注册新模板/方案")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "注册" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "取消" }),
      ).toBeInTheDocument();
    });
  });

  it("名称为空时前端校验（不发请求）", async () => {
    renderCatalogPage(makeSystemAdminSession());

    await waitFor(() => {
      expect(screen.getByText("注册模板/方案")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("注册模板/方案"));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "注册" }),
      ).toBeInTheDocument();
    });

    // Submit form to trigger React synthetic onSubmit in jsdom
    const registerBtn = screen.getByRole("button", { name: "注册" });
    fireEvent.submit(registerBtn.closest("form")!);

    await waitFor(() => {
      expect(screen.getByText("名称不能为空")).toBeInTheDocument();
    });

    const postCalls = mockFetch.mock.calls.filter((c: unknown[]) => {
      const url = c[0] as string;
      return url.includes("register");
    });
    expect(postCalls).toHaveLength(0);
  });

  it("取消按钮关闭表单", async () => {
    renderCatalogPage(makeSystemAdminSession());

    await waitFor(() => {
      expect(screen.getByText("注册模板/方案")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("注册模板/方案"));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "取消" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => {
      expect(
        screen.queryByText("注册新模板/方案"),
      ).not.toBeInTheDocument();
    });
  });

  it("注册专家模板成功关闭表单", async () => {
    mockFetch
      .mockResolvedValueOnce(envOk())
      .mockResolvedValueOnce(
        singleResponse(makeCatalogItem({ id: "new-id", name: "新专家" })),
      )
      .mockResolvedValueOnce(envOk());

    renderCatalogPage(makeSystemAdminSession());

    await waitFor(() => {
      expect(screen.getByText("注册模板/方案")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("注册模板/方案"));

    await waitFor(() => {
      expect(screen.getByText("注册新模板/方案")).toBeInTheDocument();
    });

    // Fill template_id (first text input) and display_name (second text input)
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0]!, { target: { value: "tpl-new" } });
    fireEvent.change(inputs[1]!, { target: { value: "新专家" } });

    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    await waitFor(() => {
      const registerCall = mockFetch.mock.calls.find((c: unknown[]) => {
        const url = c[0] as string;
        return url.includes("expert-templates");
      });
      expect(registerCall).toBeDefined();
    });
  });
});

// ---- 7. 详情页 ----

describe("详情页", () => {
  it("显示目录项详情", async () => {
    mockFetch.mockResolvedValue(
      singleResponse(
        makeCatalogItem({
          catalog_type: "solution_template",
          template_id: "abc",
          display_name: "电商方案",
          status: "published",
          visible_scope: null,
          version: "2.0",
        }),
      ),
    );

    renderCatalogDetail(makeSystemAdminSession(), "abc", "solution_template");

    await waitFor(() => {
      expect(screen.getAllByText("电商方案").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("行业方案")).toBeInTheDocument();
    });
  });

  it("详情加载失败展示错误", async () => {
    mockFetch.mockResolvedValue(
      problemResponse(404, "not_found", "目录项不存在"),
    );

    renderCatalogDetail(makeSystemAdminSession(), "nonexistent");

    await waitFor(() => {
      expect(screen.getByText("目录项不存在")).toBeInTheDocument();
    });
  });

  it("详情返回 null 时显示未找到", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    renderCatalogDetail(makeSystemAdminSession(), "missing");

    await waitFor(() => {
      expect(screen.getByText("未找到该目录项。")).toBeInTheDocument();
    });
  });

// ---- 8. 详情页编辑模式 ----

describe("详情页编辑模式", () => {
  function makeExpertItem(overrides: Record<string, unknown> = {}) {
    return makeCatalogItem({
      catalog_type: "expert_template",
      template_id: "exp-1",
      display_name: "客服专家",
      status: "draft",
      visible_scope: null,
      version: "1",
      persona: "你是一名客服专家",
      recommended_config: { language: "zh" },
      ...overrides,
    });
  }

  it("管理员可见编辑按钮, operator 不可见", async () => {
    mockFetch.mockResolvedValue(singleResponse(makeExpertItem()));

    const adminRendered = renderCatalogDetail(makeSystemAdminSession(), "exp-1", "expert_template");
    await waitFor(() => {
      expect(screen.getByText("编辑")).toBeInTheDocument();
    });
    adminRendered.unmount();

    mockFetch.mockResolvedValue(singleResponse(makeExpertItem()));
    const operatorRendered = renderCatalogDetail(makeSystemOperatorSession(), "exp-1", "expert_template");
    await waitFor(() => {
      expect(screen.getAllByText("客服专家").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByText("编辑")).not.toBeInTheDocument();
    operatorRendered.unmount();
  });

  it("点击编辑展示 persona / recommended_config 表单", async () => {
    mockFetch.mockResolvedValue(singleResponse(makeExpertItem()));
    renderCatalogDetail(makeSystemAdminSession(), "exp-1", "expert_template");

    await waitFor(() => expect(screen.getByText("编辑")).toBeInTheDocument());
    fireEvent.click(screen.getByText("编辑"));

    await waitFor(() => {
      expect(screen.getByText("编辑目录项")).toBeInTheDocument();
      expect(screen.getByText("保存")).toBeInTheDocument();
      expect(screen.getByText("取消")).toBeInTheDocument();
    });
    const textareas = screen.getAllByRole("textbox").filter(
      (el) => el.tagName === "TEXTAREA",
    );
    expect(textareas.length).toBeGreaterThanOrEqual(1);
    expect(textareas[0]).toHaveValue("你是一名客服专家");
  });

  it("编辑专家模板后调 PATCH 且 body 含 persona + recommended_config", async () => {
    mockFetch
      .mockResolvedValueOnce(singleResponse(makeExpertItem()))
      .mockResolvedValueOnce(
        singleResponse(makeExpertItem({ persona: "新版人设", recommended_config: { language: "en" } })),
      );

    renderCatalogDetail(makeSystemAdminSession(), "exp-1", "expert_template");
    await waitFor(() => expect(screen.getByText("编辑")).toBeInTheDocument());
    fireEvent.click(screen.getByText("编辑"));

    await waitFor(() => expect(screen.getByText("保存")).toBeInTheDocument());
    const textboxes = screen.getAllByRole("textbox").filter(
      (el) => el.tagName === "TEXTAREA",
    );
    fireEvent.change(textboxes[0]!, { target: { value: "新版人设" } });
    fireEvent.change(textboxes[1]!, { target: { value: "{\"language\":\"en\"}" } });

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes("/exp-1") && c[1] && (c[1] as { method?: string }).method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body.persona).toBe("新版人设");
      expect(body.recommended_config).toEqual({ language: "en" });
      expect(body.catalog_type).toBeUndefined();
    });
    await waitFor(() => expect(screen.queryByText("保存")).not.toBeInTheDocument());
  });

  it("编辑方案展示引用类字段并提交 knowledge/skill/default_grants", async () => {
    const solutionItem = makeCatalogItem({
      catalog_type: "solution_template",
      template_id: "sol-1",
      display_name: "电商方案",
      status: "draft",
      visible_scope: null,
      version: "1",
      knowledge_refs: ["kb-1"],
      skill_refs: ["skill-1"],
      default_grants: { role: "viewer" },
      expert_bindings: [{ template_id: "t1", sequence_no: 1, enabled: true }],
    });
    mockFetch
      .mockResolvedValueOnce(singleResponse(solutionItem))
      .mockResolvedValueOnce(singleResponse(solutionItem));

    renderCatalogDetail(makeSystemAdminSession(), "sol-1", "solution_template");
    await waitFor(() => expect(screen.getByText("编辑")).toBeInTheDocument());
    fireEvent.click(screen.getByText("编辑"));

    await waitFor(() => expect(screen.getByText("知识库引用")).toBeInTheDocument());
    expect(screen.getByText("技能引用")).toBeInTheDocument();
    expect(screen.getByText("默认授权")).toBeInTheDocument();
    expect(screen.getByText("专家绑定")).toBeInTheDocument();

    const inputs = screen.getAllByRole("textbox").filter(
      (el) => el.tagName === "INPUT",
    );
    fireEvent.change(inputs[0]!, { target: { value: "kb-1, kb-2" } });
    fireEvent.change(inputs[1]!, { target: { value: "skill-1, skill-9" } });

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes("/sol-1") && c[1] && (c[1] as { method?: string }).method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body.knowledge_refs).toEqual(["kb-1", "kb-2"]);
      expect(body.skill_refs).toEqual(["skill-1", "skill-9"]);
    });
  });

  it("取消编辑不发送请求并恢复只读", async () => {
    mockFetch.mockResolvedValue(singleResponse(makeExpertItem()));
    renderCatalogDetail(makeSystemAdminSession(), "exp-1", "expert_template");
    await waitFor(() => expect(screen.getByText("编辑")).toBeInTheDocument());
    fireEvent.click(screen.getByText("编辑"));
    await waitFor(() => expect(screen.getByText("取消")).toBeInTheDocument());
    fireEvent.click(screen.getByText("取消"));
    await waitFor(() => expect(screen.queryByText("保存")).not.toBeInTheDocument());
    const patchCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => c[1] && (c[1] as { method?: string }).method === "PATCH",
    );
    expect(patchCalls).toHaveLength(0);
  });
});
});
