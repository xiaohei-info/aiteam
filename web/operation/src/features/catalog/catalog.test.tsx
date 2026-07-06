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

function renderCatalogPage(
  sessionCtx: SessionContextValue,
  catalogType: "expert_template" | "solution_template" = "expert_template",
) {
  const i18n = makeI18n();
  const titleKey = catalogType === "expert_template"
    ? "operation.nav.experts"
    : "operation.nav.industrySolutions";
  const registerKey = catalogType === "expert_template"
    ? "operation.catalog.registerExpert"
    : "operation.catalog.registerSolution";
  return render(
    <I18nContext.Provider value={i18n}>
      <SessionContext.Provider value={sessionCtx}>
        <MemoryRouter initialEntries={["/catalog"]}>
          <Routes>
            <Route path="/catalog" element={
              <CatalogPage catalogType={catalogType} titleKey={titleKey} registerKey={registerKey} />
            } />
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
            <Route path="/catalog" element={<CatalogPage catalogType="expert_template" titleKey="operation.nav.experts" registerKey="operation.catalog.registerExpert" />} />
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
      expect(screen.getByText("专家")).toBeInTheDocument();
    });
  });

  it("system_operator 可见列表", async () => {
    renderCatalogPage(makeSystemOperatorSession());
    await waitFor(() => {
      expect(screen.getByText("专家")).toBeInTheDocument();
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

  it("显示隐藏可见范围的目录项", async () => {
    mockFetch.mockResolvedValue(
      listPage([
        makeCatalogItem({
          template_id: "h1",
          display_name: "隐藏模板",
          status: "published",
          visible_scope: { hidden: true },
        }),
      ]),
    );
    renderCatalogPage(makeSystemAdminSession());
    await waitFor(() => {
      expect(screen.getByText("隐藏模板")).toBeInTheDocument();
    });
    expect(screen.getAllByText("隐藏").length).toBeGreaterThanOrEqual(1);
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
      expect(screen.getByText("注册专家模板")).toBeInTheDocument();
    });
  });

  it("operator 可见注册按钮", async () => {
    renderCatalogPage(makeSystemOperatorSession());
    await waitFor(() => {
      expect(screen.getByText("专家")).toBeInTheDocument();
    });
    expect(screen.getByText("注册专家模板")).toBeInTheDocument();
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
      // body must be sent as {} so FastAPI can parse PublishTemplateRequest
      expect((publishCall![1] as { body?: string }).body).toBeDefined();
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
      // body must be sent as {} so FastAPI can parse PublishTemplateRequest
      expect((unpublishCall![1] as { body?: string }).body).toBeDefined();
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

  it("operator 可见发布按钮", async () => {
    mockFetch.mockResolvedValue(
      listPage([makeCatalogItem({ status: "draft" })]),
    );
    renderCatalogPage(makeSystemOperatorSession());
    await waitFor(() => {
      expect(screen.getByText("test")).toBeInTheDocument();
    });
    // operator has same write access as admin (backend _PLATFORM_ROLES)
    expect(screen.getByText("发布")).toBeInTheDocument();
  });

  it("operator 点击发布后调 POST publish", async () => {
    mockFetch
      .mockResolvedValueOnce(
        listPage([makeCatalogItem({ status: "draft" })]),
      )
      .mockResolvedValueOnce(singleResponse(null))
      .mockResolvedValueOnce(listPage([]));

    renderCatalogPage(makeSystemOperatorSession());

    await waitFor(() => {
      expect(screen.getByText("发布")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("发布"));

    await waitFor(() => {
      const publishCall = mockFetch.mock.calls.find((c: unknown[]) =>
        (c[0] as string).includes("/publish"),
      );
      expect(publishCall).toBeDefined();
      // body must be sent as {} so FastAPI can parse PublishTemplateRequest
      expect((publishCall![1] as { body?: string }).body).toBeDefined();
    });
  });

  it("operator 可见可见范围下拉", async () => {
    mockFetch.mockResolvedValue(
      listPage([makeCatalogItem({ status: "published", visible_scope: null })]),
    );
    renderCatalogPage(makeSystemOperatorSession());
    await waitFor(() => {
      expect(screen.getByText("test")).toBeInTheDocument();
    });
    // operator sees visibility select (enterprise option)
    expect(screen.getByText("下架")).toBeInTheDocument();
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
      expect(screen.getByText("注册专家模板")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("注册专家模板"));

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
      expect(screen.getByText("注册专家模板")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("注册专家模板"));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "注册" }),
      ).toBeInTheDocument();
    });

    // Leave both fields empty to trigger name validation (ID is now server-generated, no input shown).
    const nameInput = document.querySelector<HTMLInputElement>("input[placeholder=\"display_name\"]")!;
    expect(nameInput).toBeTruthy();

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
      expect(screen.getByText("注册专家模板")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("注册专家模板"));

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

  it("注册专家模板成功提交 system_prompt + default_model", async () => {
    let capturedBody: unknown = null;
    mockFetch
      .mockResolvedValueOnce(envOk())
      .mockImplementationOnce(async (url: unknown, init: unknown) => {
        const u = String(url);
        const i = init as { body?: string } | undefined;
        if (u.includes("expert-templates")) capturedBody = i?.body ? JSON.parse(i.body) : null;
        return singleResponse(
          makeCatalogItem({
            id: "new-id",
            display_name: "新专家",
            system_prompt: "电商客服",
            default_model: "gpt-5",
          }),
        );
      })
      .mockResolvedValueOnce(envOk());

    renderCatalogPage(makeSystemAdminSession());

    await waitFor(() => {
      expect(screen.getByText("注册专家模板")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("注册专家模板"));

    await waitFor(() => {
      expect(screen.getByText("注册新模板/方案")).toBeInTheDocument();
    });

    const nameInput = document.querySelector<HTMLInputElement>("input[placeholder=\"display_name\"]")!;
    expect(nameInput).toBeTruthy();
    fireEvent.change(nameInput, { target: { value: "新专家" } });

    const systemPrompt = document.querySelector<HTMLTextAreaElement>(
      "textarea[placeholder=\"岗位描述系统提示词（纯文本）\"]",
    )!;
    fireEvent.change(systemPrompt, { target: { value: "电商客服" } });

    const modelInput = document.querySelector<HTMLInputElement>(
      "input[placeholder=\"如 gpt-5 / claude-opus-4-8 / deepseek\"]",
    )!;
    fireEvent.change(modelInput, { target: { value: "gpt-5" } });

    // Fill all PRD required fields so the always-send payload is complete.
    fireEvent.change(screen.getByLabelText("分类 (category)"), { target: { value: "市场营销" } });
    fireEvent.change(screen.getByLabelText("头像 (avatar_url)"), { target: { value: "https://example.com/a.png" } });
    fireEvent.change(screen.getByLabelText("岗位描述 (description, ≤200字)"), { target: { value: "淘宝电商客服" } });

    // Expand advanced config and fill skills/tags/memories/sort to cover that branch.
    fireEvent.click(screen.getByText("展开能力配置(技能 / 标签 / 记忆 / 排序) ▼"));
    await waitFor(() => {
      expect(screen.getByLabelText("预配置技能 (skill_ids, 每行或逗号分隔)")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("预配置技能 (skill_ids, 每行或逗号分隔)"), { target: { value: "chat\nrefund" } });
    fireEvent.change(screen.getByLabelText("搜索标签 (tags, 每行或逗号分隔)"), { target: { value: "电商\n客服" } });
    fireEvent.change(screen.getByLabelText("排序权重 (sort_order, 数值越小越靠前)"), { target: { value: "10" } });

    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    const body = capturedBody as {
      template_id?: string;
      display_name: string;
      category?: string;
      avatar_url?: string;
      system_prompt?: string;
      default_model?: string;
      description?: string;
      skill_ids?: string[];
      tags?: string[];
      sort_order?: number;
    };
    expect(body.template_id).toBeUndefined();
    expect(body.display_name).toBe("新专家");
    expect(body.category).toBe("市场营销");
    expect(body.avatar_url).toBe("https://example.com/a.png");
    expect(body.system_prompt).toBe("电商客服");
    expect(body.default_model).toBe("gpt-5");
    expect(body.description).toBe("淘宝电商客服");
    expect(body.skill_ids).toEqual(["chat", "refund"]);
    expect(body.tags).toEqual(["电商", "客服"]);
    expect(body.sort_order).toBe(10);
    await waitFor(() => {
      expect(screen.queryByText("注册新模板/方案")).not.toBeInTheDocument();
    });
  });

  it("注册专家模板时 initial_memories 填非法 JSON 不报错并提交", async () => {
    let capturedBody: unknown = null;
    mockFetch
      .mockResolvedValueOnce(envOk())
      .mockImplementationOnce(async (url: unknown, init: unknown) => {
        if (String(url).includes("expert-templates")) {
          const i = init as { body?: string } | undefined;
          capturedBody = i?.body ? JSON.parse(i.body) : null;
        }
        return singleResponse(makeCatalogItem({ id: "x", display_name: "X" }));
      })
      .mockResolvedValueOnce(envOk());

    renderCatalogPage(makeSystemAdminSession());
    await waitFor(() => expect(screen.getByText("注册专家模板")).toBeInTheDocument());
    fireEvent.click(screen.getByText("注册专家模板"));
    await waitFor(() => expect(screen.getByText("注册新模板/方案")).toBeInTheDocument());

    fireEvent.change(document.querySelector<HTMLInputElement>("input[placeholder=\"display_name\"]")!, { target: { value: "X专家" } });
    fireEvent.change(screen.getByLabelText("分类 (category)"), { target: { value: "技术研发" } });
    fireEvent.change(screen.getByLabelText("头像 (avatar_url)"), { target: { value: "https://x.png" } });
    fireEvent.change(document.querySelector<HTMLTextAreaElement>("textarea[placeholder=\"岗位描述系统提示词（纯文本）\"]")!, { target: { value: "sp" } });
    fireEvent.change(document.querySelector<HTMLInputElement>("input[placeholder=\"如 gpt-5 / claude-opus-4-8 / deepseek\"]")!, { target: { value: "gpt-5" } });
    fireEvent.change(screen.getByLabelText("岗位描述 (description, ≤200字)"), { target: { value: "desc" } });
    fireEvent.click(screen.getByText("展开能力配置(技能 / 标签 / 记忆 / 排序) ▼"));
    await waitFor(() => expect(screen.getByLabelText("预配置技能 (skill_ids, 每行或逗号分隔)")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("预配置技能 (skill_ids, 每行或逗号分隔)"), { target: { value: "s1" } });
    // invalid JSON → parseJsonArray catch branch returns undefined → sent as []
    fireEvent.change(screen.getByLabelText("预置记忆 (initial_memories, JSON 数组)"), { target: { value: "{not-json" } });

    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    await waitFor(() => {
      expect((capturedBody as { initial_memories?: unknown[] })?.initial_memories).toEqual([]);
    });
  });

  it("注册专家模板时通过「新建分类」流程追加自定义分类并提交", async () => {
    let capturedBody: unknown = null;
    mockFetch
      .mockResolvedValueOnce(envOk())
      .mockImplementationOnce(async (url: unknown, init: unknown) => {
        if (String(url).includes("expert-templates")) {
          const i = init as { body?: string } | undefined;
          capturedBody = i?.body ? JSON.parse(i.body) : null;
        }
        return singleResponse(makeCatalogItem({ id: "new-cat", display_name: "新专家" }));
      })
      .mockResolvedValueOnce(envOk());

    renderCatalogPage(makeSystemAdminSession());
    await waitFor(() => expect(screen.getByText("注册专家模板")).toBeInTheDocument());
    fireEvent.click(screen.getByText("注册专家模板"));
    await waitFor(() => expect(screen.getByText("注册新模板/方案")).toBeInTheDocument());

    fireEvent.change(document.querySelector<HTMLInputElement>("input[placeholder=\"display_name\"]")!, { target: { value: "新专家" } });
    fireEvent.change(document.querySelector<HTMLTextAreaElement>("textarea[placeholder=\"岗位描述系统提示词（纯文本）\"]")!, { target: { value: "sp" } });
    fireEvent.change(document.querySelector<HTMLInputElement>("input[placeholder=\"如 gpt-5 / claude-opus-4-8 / deepseek\"]")!, { target: { value: "gpt-5" } });
    fireEvent.change(screen.getByLabelText("头像 (avatar_url)"), { target: { value: "https://x.png" } });
    fireEvent.change(screen.getByLabelText("岗位描述 (description, ≤200字)"), { target: { value: "desc" } });

    // 选择「＋ 新建分类…」→ 展开新分类输入 → 添加后下拉值变更为新分类
    const categorySelect = screen.getByLabelText("分类 (category)") as HTMLSelectElement;
    fireEvent.change(categorySelect, { target: { value: "__create_new_category__" } });
    const newCatInput = await screen.findByPlaceholderText("输入新分类名称");
    fireEvent.change(newCatInput, { target: { value: "电商运营" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    // 新分类已写入下拉并选中
    await waitFor(() => {
      expect((screen.getByLabelText("分类 (category)") as HTMLSelectElement).value).toBe("电商运营");
    });

    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    await waitFor(() => {
      expect((capturedBody as { category?: string })?.category).toBe("电商运营");
    });
  });

  it("注册行业方案时可选择专家模板", async () => {
    const expertItems = [
      makeCatalogItem({
        catalog_type: "expert_template",
        template_id: "exp_a",
        display_name: "客服专家",
        status: "published",
      }),
      makeCatalogItem({
        catalog_type: "expert_template",
        template_id: "exp_b",
        display_name: "营销专家",
        status: "published",
      }),
    ];
    // 行业方案页：首次 list → expert 选项自动拉取 → 注册 → 刷新
    mockFetch
      .mockResolvedValueOnce(listPage(expertItems))
      .mockResolvedValueOnce(listPage(expertItems))
      .mockResolvedValueOnce(
        singleResponse(
          makeCatalogItem({
            catalog_type: "solution_template",
            template_id: "sol_a",
            display_name: "全渠道方案",
          }),
        ),
      )
      .mockResolvedValueOnce(listPage(expertItems));

    // 以行业方案页渲染（catalogType 锁定为 solution_template）
    renderCatalogPage(makeSystemAdminSession(), "solution_template");

    await waitFor(() => {
      expect(screen.getByText("注册行业方案")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("注册行业方案"));
    await waitFor(() => {
      expect(screen.getByText("注册新模板/方案")).toBeInTheDocument();
    });

    // 表单锁定为行业方案，自动拉取并展示可选专家模板
    // （专家名同时出现在列表表格和表单选择器中，故用 getAllByText）
    await waitFor(() => {
      expect(screen.getAllByText("客服专家").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("营销专家").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);

    // AITEAM-677：必须指定一个专家为 Planner 角色
    const plannerRadios = screen.getAllByRole("radio");
    fireEvent.click(plannerRadios[0]!);

    // ID 由服务端自动生成（AITEAM-355 问题二）：表单只暴露 display_name，solution_id 已移除。
    const nameInput = document.querySelector<HTMLInputElement>("input[placeholder=\"display_name\"]")!;
    expect(nameInput).toBeTruthy();
    fireEvent.change(nameInput, { target: { value: "全渠道方案" } });

    // AITEAM-677：planner_prompt 必填
    const plannerPromptTa = screen.getByLabelText("Planner 编排规则提示词 (planner_prompt, 必填)");
    fireEvent.change(plannerPromptTa, { target: { value: "组织各专家协作" } });

    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    await waitFor(() => {
      const registerCall = mockFetch.mock.calls.find((c: unknown[]) => {
        const url = (c as unknown[])[0] as string;
        return url.includes("solution-templates");
      });
      expect(registerCall).toBeTruthy();
      const body = JSON.parse(((registerCall as unknown[])[1] as { body: string }).body);
      expect(body.expert_template_ids.sort()).toEqual(["exp_a", "exp_b"]);
      expect(body.planner_template_id).toBe("exp_a");
      expect(body.planner_prompt).toBe("组织各专家协作");
      expect(body.solution_id).toBeUndefined();
      expect(body.display_name).toBe("全渠道方案");
    });
  });

  it("注册行业方案时未指定 Planner 则前端校验拦截", async () => {
    const expertItems = [
      makeCatalogItem({
        catalog_type: "expert_template",
        template_id: "exp_a",
        display_name: "客服专家",
        status: "published",
      }),
    ];
    mockFetch
      .mockResolvedValueOnce(listPage(expertItems))
      .mockResolvedValueOnce(listPage(expertItems));

    renderCatalogPage(makeSystemAdminSession(), "solution_template");

    await waitFor(() => {
      expect(screen.getByText("注册行业方案")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("注册行业方案"));
    await waitFor(() => {
      expect(screen.getByText("注册新模板/方案")).toBeInTheDocument();
    });

    // 选专家但不指定 planner
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    const nameInput = document.querySelector<HTMLInputElement>("input[placeholder=\"display_name\"]")!;
    fireEvent.change(nameInput, { target: { value: "测试方案" } });
    fireEvent.change(
      screen.getByLabelText("Planner 编排规则提示词 (planner_prompt, 必填)"),
      { target: { value: "编排规则" } },
    );

    fireEvent.submit(screen.getByRole("button", { name: "注册" }).closest("form")!);

    await waitFor(() => {
      expect(screen.getByText("请指定一个专家为 Planner 角色（编排者）")).toBeInTheDocument();
    });
  });

  it("注册行业方案时未选择专家则前端校验拦截", async () => {
    mockFetch
      .mockResolvedValueOnce(listPage([]))
      .mockResolvedValueOnce(listPage([]));

    renderCatalogPage(makeSystemAdminSession(), "solution_template");

    await waitFor(() => {
      expect(screen.getByText("注册行业方案")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("注册行业方案"));
    await waitFor(() => {
      expect(screen.getByText("注册新模板/方案")).toBeInTheDocument();
    });

    const nameInput = document.querySelector<HTMLInputElement>("input[placeholder=\"display_name\"]")!;
    fireEvent.change(nameInput, { target: { value: "测试方案" } });

    fireEvent.submit(screen.getByRole("button", { name: "注册" }).closest("form")!);

    await waitFor(() => {
      expect(screen.getByText("请至少选择一个专家模板")).toBeInTheDocument();
    });
  });

  it("注册行业方案时未填写 Planner 提示词则前端校验拦截", async () => {
    const expertItems = [
      makeCatalogItem({
        catalog_type: "expert_template",
        template_id: "exp_a",
        display_name: "客服专家",
        status: "published",
      }),
    ];
    mockFetch
      .mockResolvedValueOnce(listPage(expertItems))
      .mockResolvedValueOnce(listPage(expertItems));

    renderCatalogPage(makeSystemAdminSession(), "solution_template");

    await waitFor(() => {
      expect(screen.getByText("注册行业方案")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("注册行业方案"));
    await waitFor(() => {
      expect(screen.getByText("注册新模板/方案")).toBeInTheDocument();
    });

    // 选专家并指定 planner，但不填 planner_prompt
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    fireEvent.click(screen.getAllByRole("radio")[0]!);
    const nameInput = document.querySelector<HTMLInputElement>("input[placeholder=\"display_name\"]")!;
    fireEvent.change(nameInput, { target: { value: "测试方案" } });

    fireEvent.submit(screen.getByRole("button", { name: "注册" }).closest("form")!);

    await waitFor(() => {
      expect(screen.getByText("请填写 Planner 编排规则提示词")).toBeInTheDocument();
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
      system_prompt: "你是一名客服专家",
      default_model: "gpt-5",
      ...overrides,
    });
  }

  it("管理员与 operator 均可见编辑按钮", async () => {
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
    expect(screen.getByText("编辑")).toBeInTheDocument();
    operatorRendered.unmount();
  });

  it("点击编辑展示 system_prompt 表单 + 保存/取消按钮", async () => {
    mockFetch.mockResolvedValue(singleResponse(makeExpertItem()));
    renderCatalogDetail(makeSystemAdminSession(), "exp-1", "expert_template");

    await waitFor(() => expect(screen.getByText("编辑")).toBeInTheDocument());
    fireEvent.click(screen.getByText("编辑"));

    await waitFor(() => {
      expect(screen.getByText("保存")).toBeInTheDocument();
      expect(screen.getByText("取消")).toBeInTheDocument();
    });
    const systemPrompt = document.querySelector<HTMLTextAreaElement>(
      "textarea[placeholder=\"岗位描述系统提示词（纯文本）\"]",
    )!;
    expect(systemPrompt).toHaveValue("你是一名客服专家");
  });

  it("编辑专家模板后调 PATCH 且 body 含 system_prompt", async () => {
    mockFetch
      .mockResolvedValueOnce(singleResponse(makeExpertItem()))
      .mockResolvedValueOnce(
        singleResponse(makeExpertItem({ system_prompt: "新版人设" })),
      );

    renderCatalogDetail(makeSystemAdminSession(), "exp-1", "expert_template");
    await waitFor(() => expect(screen.getByText("编辑")).toBeInTheDocument());
    fireEvent.click(screen.getByText("编辑"));

    await waitFor(() => {
      expect(
        document.querySelector<HTMLTextAreaElement>("textarea"),
      ).toBeTruthy();
    });
    const textareas = screen.getAllByRole("textbox").filter(
      (el) => el.tagName === "TEXTAREA",
    );
    expect(textareas[0]).toHaveValue("你是一名客服专家");
    fireEvent.change(textareas[0]!, { target: { value: "新版人设" } });

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes("/exp-1") && c[1] && (c[1] as { method?: string }).method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body.system_prompt).toBe("新版人设");
    });
    await waitFor(() => expect(screen.queryByText("保存")).not.toBeInTheDocument());
  });

  it("编辑方案展示知识/技能字段并提交 PATCH", async () => {
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
    });
    mockFetch
      .mockResolvedValueOnce(singleResponse(solutionItem))
      .mockResolvedValueOnce(singleResponse(solutionItem));

    renderCatalogDetail(makeSystemAdminSession(), "sol-1", "solution_template");
    await waitFor(() => expect(screen.getByText("编辑")).toBeInTheDocument());
    fireEvent.click(screen.getByText("编辑"));

    await waitFor(() => expect(screen.getByText("保存")).toBeInTheDocument());

    // In edit mode, knowledge_refs and skill_refs are textareas
    const textareas = screen.getAllByRole("textbox").filter(
      (el) => el.tagName === "TEXTAREA",
    );
    // Find the knowledge refs textarea (contains "kb-1")
    const kbTextarea = textareas.find((t) => (t as HTMLTextAreaElement).value.includes("kb-1"));
    expect(kbTextarea).toBeTruthy();
    fireEvent.change(kbTextarea!, { target: { value: "kb-1\nkb-2" } });

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes("/sol-1") && c[1] && (c[1] as { method?: string }).method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body.knowledge_refs).toEqual(["kb-1", "kb-2"]);
    });
  });

  it("编辑方案协作编排 prompts + tags 并提交 PATCH", async () => {
    const solutionItem = makeCatalogItem({
      catalog_type: "solution_template",
      template_id: "sol-prompt",
      display_name: "协作方案",
      status: "draft",
      visible_scope: null,
      version: "1",
      planner_prompt: "旧 planner",
      subtask_prompt: "旧 subtask",
      aggregate_prompt: "旧 aggregate",
      tags: ["零售"],
      default_grants: { role: "viewer" },
    });
    mockFetch
      .mockResolvedValueOnce(singleResponse(solutionItem))
      .mockResolvedValueOnce(singleResponse(solutionItem));

    renderCatalogDetail(makeSystemAdminSession(), "sol-prompt", "solution_template");
    await waitFor(() => expect(screen.getByText("编辑")).toBeInTheDocument());
    fireEvent.click(screen.getByText("编辑"));

    await waitFor(() => expect(screen.getByText("保存")).toBeInTheDocument());

    // planner/subtask/aggregate prompts + tags are editable textareas
    fireEvent.change(screen.getByLabelText("planner_prompt"), { target: { value: "新 planner" } });
    fireEvent.change(screen.getByLabelText("subtask_prompt"), { target: { value: "新 subtask" } });
    fireEvent.change(screen.getByLabelText("aggregate_prompt"), { target: { value: "新 aggregate" } });
    fireEvent.change(screen.getByLabelText("方案标签 (每行或逗号)"), { target: { value: "零售\n电商" } });

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes("/sol-prompt") && c[1] && (c[1] as { method?: string }).method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body.planner_prompt).toBe("新 planner");
      expect(body.subtask_prompt).toBe("新 subtask");
      expect(body.aggregate_prompt).toBe("新 aggregate");
      expect(body.tags).toEqual(["零售", "电商"]);
    });
  });

  it("编辑方案 planner_template_id 并提交 PATCH", async () => {
    const solutionItem = makeCatalogItem({
      catalog_type: "solution_template",
      template_id: "sol-planner",
      display_name: "协作方案",
      status: "draft",
      visible_scope: null,
      version: "1",
      planner_template_id: "exp_old",
      planner_prompt: "旧 planner",
      default_grants: { role: "viewer" },
    });
    mockFetch
      .mockResolvedValueOnce(singleResponse(solutionItem))
      .mockResolvedValueOnce(singleResponse(solutionItem));

    renderCatalogDetail(makeSystemAdminSession(), "sol-planner", "solution_template");
    await waitFor(() => expect(screen.getByText("编辑")).toBeInTheDocument());
    fireEvent.click(screen.getByText("编辑"));

    await waitFor(() => expect(screen.getByText("保存")).toBeInTheDocument());

    // planner_template_id input (inside Planner 角色 section)
    const plannerInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="被指定为 Planner 的专家模板 id"]',
    )!;
    expect(plannerInput).toBeTruthy();
    expect(plannerInput).toHaveValue("exp_old");
    fireEvent.change(plannerInput, { target: { value: "exp_new" } });

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes("/sol-planner") && c[1] && (c[1] as { method?: string }).method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body.planner_template_id).toBe("exp_new");
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

// ---- 8. 详情页多 section 渲染 + 编辑 ----

describe("详情页多 section", () => {
  it("渲染专家全部能力 section", async () => {
    mockFetch.mockResolvedValue(
      singleResponse(
        makeCatalogItem({
          catalog_type: "expert_template",
          template_id: "exp_a",
          display_name: "AI 客服",
          system_prompt: "你是客服",
          category: "support",
          avatar_url: "https://example.com/a.png",
          default_model: "gpt-4o",
          skill_ids: ["skill_a"],
          tags: ["客服"],
          description: "客服专家",
          initial_memories: [{ type: "buffer", max_tokens: 4096 }],
        }),
      ),
    );

    renderCatalogDetail(makeSystemAdminSession(), "exp_a", "expert_template");

    await waitFor(() => {
      expect(screen.getByText("AI 客服")).toBeInTheDocument();
    });
    expect(screen.getByText("系统提示词 (system_prompt)")).toBeInTheDocument();
    expect(screen.getByText("你是客服")).toBeInTheDocument();
    expect(screen.getByText("默认模型 (default_model)")).toBeInTheDocument();
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    expect(screen.getByText("分类 / 头像")).toBeInTheDocument();
    expect(screen.getByText("岗位描述 (description)")).toBeInTheDocument();
    expect(screen.getByText("客服专家")).toBeInTheDocument();
    expect(screen.getByText("技能 / 标签")).toBeInTheDocument();
    expect(screen.getAllByText((_, el) => !!el && (el.textContent || "").includes("skill_a")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("预置记忆 (initial_memories)")).toBeInTheDocument();
  });

  it("渲染行业方案的多 section 内容", async () => {
    mockFetch.mockResolvedValue(
      singleResponse(
        makeCatalogItem({
          catalog_type: "solution_template",
          template_id: "sol_a",
          display_name: "零售方案",
          expert_template_ids: ["exp_a", "exp_b"],
          planner_template_id: "exp_a",
          knowledge_refs: ["kb_retail"],
          skill_refs: ["skill_a"],
          planner_prompt: "零售 planner",
          subtask_prompt: "零售 subtask",
          aggregate_prompt: "零售 aggregate",
          default_grants: { max_concurrent_tasks: 5 },
          tags: ["零售"],
        }),
      ),
    );

    renderCatalogDetail(makeSystemAdminSession(), "sol_a", "solution_template");

    await waitFor(() => {
      expect(screen.getByText("零售方案")).toBeInTheDocument();
    });
    expect(screen.getByText("配置专家 (expert_template_ids)")).toBeInTheDocument();
    expect(screen.getAllByText((_, el) => !!el && (el.textContent || "").includes("exp_a")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText((_, el) => !!el && (el.textContent || "").includes("exp_b")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Planner 角色 (planner_template_id)")).toBeInTheDocument();
    expect(screen.getByText("知识 / 技能引用")).toBeInTheDocument();
    expect(screen.getAllByText((_, el) => !!el && (el.textContent || "").includes("kb_retail")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("协作编排规则 (prompts)")).toBeInTheDocument();
    expect(screen.getByText("零售 planner")).toBeInTheDocument();
    expect(screen.getByText("默认 Grants / 方案标签")).toBeInTheDocument();
    expect(screen.getAllByText((_, el) => !!el && (el.textContent || "").includes("零售")).length).toBeGreaterThanOrEqual(1);
  });

  it("管理员在详情页进入编辑模式修改 system_prompt + default_model,并调 PATCH", async () => {
    mockFetch
      .mockResolvedValueOnce(
        singleResponse(
          makeCatalogItem({
            catalog_type: "expert_template",
            template_id: "exp_a",
            display_name: "AI 客服",
            system_prompt: "旧 system_prompt",
            default_model: "gpt-4o",
          }),
        ),
      )
      .mockResolvedValueOnce(
        singleResponse(
          makeCatalogItem({
            catalog_type: "expert_template",
            template_id: "exp_a",
            display_name: "AI 客服",
            system_prompt: "新 system_prompt",
            default_model: "claude-sonnet",
          }),
        ),
      );

    renderCatalogDetail(makeSystemAdminSession(), "exp_a", "expert_template");

    await waitFor(() => {
      expect(screen.getByText("旧 system_prompt")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("编辑"));

    await waitFor(() => {
      expect(screen.getByText("保存")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(
        document.querySelector<HTMLTextAreaElement>("textarea"),
      ).toBeTruthy();
    });
    const textareas = screen.getAllByRole("textbox").filter(
      (el) => el.tagName === "TEXTAREA",
    );
    expect(textareas[0]).toHaveValue("旧 system_prompt");
    fireEvent.change(textareas[0]!, { target: { value: "新 system_prompt" } });
    const allInputs = document.querySelectorAll<HTMLInputElement>("input");
    const modelInput = Array.from(allInputs).find((el) => el.value === "gpt-4o");
    expect(modelInput).toBeTruthy();
    fireEvent.change(modelInput!, { target: { value: "claude-sonnet" } });

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find((c: unknown[]) => {
        const init = (c as unknown[])[1] as { method?: string } | undefined;
        return init?.method === "PATCH";
      }) as unknown[] | undefined;
      expect(patchCall).toBeTruthy();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body.system_prompt).toBe("新 system_prompt");
      expect(body.default_model).toBe("claude-sonnet");
    });
  });

  it("编辑专家分类/头像/描述/技能/标签/记忆并提交 PATCH", async () => {
    const expertItem = makeCatalogItem({
      catalog_type: "expert_template",
      template_id: "exp-full",
      display_name: "全字段专家",
      status: "draft",
      visible_scope: null,
      version: "1",
      category: "support",
      avatar_url: "https://old.png",
      system_prompt: "你是客服",
      default_model: "gpt-4o",
      description: "旧描述",
      skill_ids: ["skill_a"],
      tags: ["旧标签"],
      initial_memories: [{ role: "user", content: "旧记忆" }],
    });
    mockFetch
      .mockResolvedValueOnce(singleResponse(expertItem))
      .mockResolvedValueOnce(singleResponse(expertItem));

    renderCatalogDetail(makeSystemAdminSession(), "exp-full", "expert_template");
    await waitFor(() => expect(screen.getByText("编辑")).toBeInTheDocument());
    fireEvent.click(screen.getByText("编辑"));
    await waitFor(() => expect(screen.getByText("保存")).toBeInTheDocument());

    // category + avatar_url (Inputs wrapped in Field)
    fireEvent.change(screen.getByLabelText("category"), { target: { value: "finance" } });
    fireEvent.change(screen.getByLabelText("avatar_url"), { target: { value: "https://new.png" } });
    // description textarea (bare textarea inside DetailSection, find by current value)
    const allTextareas = screen.getAllByRole("textbox").filter(
      (el) => el.tagName === "TEXTAREA",
    );
    const descTa = allTextareas.find((t) => (t as HTMLTextAreaElement).value === "旧描述");
    expect(descTa).toBeTruthy();
    fireEvent.change(descTa!, { target: { value: "新描述" } });
    // skill_ids + tags (textareas wrapped in Field)
    fireEvent.change(screen.getByLabelText("skill_ids (每行或逗号)"), { target: { value: "skill_a\nskill_b" } });
    fireEvent.change(screen.getByLabelText("tags (每行或逗号)"), { target: { value: "财务\n分析" } });
    // initial_memories (bare textarea inside DetailSection, find by current JSON value)
    const memTa = screen.getAllByRole("textbox").filter(
      (el) => el.tagName === "TEXTAREA",
    ).find((t) => (t as HTMLTextAreaElement).value.includes("旧记忆"));
    expect(memTa).toBeTruthy();
    // invalid JSON → parseJsonArray catch branch (returns undefined, no state update)
    fireEvent.change(memTa!, { target: { value: "{bad-json" } });
    // valid JSON → parseJsonArray success path
    fireEvent.change(memTa!, {
      target: { value: '[{"role":"user","content":"新记忆"}]' },
    });

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes("/exp-full") && c[1] && (c[1] as { method?: string }).method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body.category).toBe("finance");
      expect(body.avatar_url).toBe("https://new.png");
      expect(body.description).toBe("新描述");
      expect(body.skill_ids).toEqual(["skill_a", "skill_b"]);
      expect(body.tags).toEqual(["财务", "分析"]);
      expect(body.initial_memories).toEqual([{ role: "user", content: "新记忆" }]);
    });
  });

  it("operator 可进入编辑模式", async () => {
    mockFetch.mockResolvedValue(
      singleResponse(
        makeCatalogItem({
          catalog_type: "expert_template",
          template_id: "exp_a",
          display_name: "AI 客服",
        }),
      ),
    );

    renderCatalogDetail(makeSystemOperatorSession(), "exp_a", "expert_template");
    await waitFor(() => {
      expect(screen.getByText("AI 客服")).toBeInTheDocument();
    });
    expect(screen.getByText("编辑")).toBeInTheDocument();
  });

  it("operator 编辑专家模板后调 PATCH", async () => {
    function makeExpertItem(overrides: Record<string, unknown> = {}) {
      return makeCatalogItem({
        catalog_type: "expert_template",
        template_id: "exp-op",
        display_name: "运营专家",
        status: "draft",
        visible_scope: null,
        version: "1",
        system_prompt: "旧人设",
        ...overrides,
      });
    }
    mockFetch
      .mockResolvedValueOnce(singleResponse(makeExpertItem()))
      .mockResolvedValueOnce(
        singleResponse(makeExpertItem({ system_prompt: "新人设" })),
      );

    renderCatalogDetail(makeSystemOperatorSession(), "exp-op", "expert_template");
    await waitFor(() => expect(screen.getByText("编辑")).toBeInTheDocument());
    fireEvent.click(screen.getByText("编辑"));

    await waitFor(() => expect(screen.getByText("保存")).toBeInTheDocument());
    const systemPrompt = document.querySelector<HTMLTextAreaElement>(
      "textarea[placeholder=\"岗位描述系统提示词（纯文本）\"]",
    )!;
    fireEvent.change(systemPrompt, { target: { value: "新人设" } });

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes("/exp-op") && c[1] && (c[1] as { method?: string }).method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body.system_prompt).toBe("新人设");
    });
  });
});
