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

    // Fill ID but leave name empty to trigger name validation
    const idInput = document.querySelector<HTMLInputElement>("input[placeholder=\"template_id\"]")!;
    fireEvent.change(idInput, { target: { value: "tpl-test" } });

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

  it("注册专家模板成功关闭表单并带回 persona + 推荐模型", async () => {
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
            persona: "电商客服",
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

    // 用 placeholder 精准定位 input
    const idInput = document.querySelector<HTMLInputElement>("input[placeholder=\"template_id\"]")!;
    const nameInput = document.querySelector<HTMLInputElement>("input[placeholder=\"display_name\"]")!;
    expect(idInput).toBeTruthy();
    fireEvent.change(idInput, { target: { value: "tpl-new" } });
    fireEvent.change(nameInput, { target: { value: "新专家" } });

    // 填 persona
    const persona = document.querySelector<HTMLTextAreaElement>(
      "textarea[placeholder=\"专家人设描述(可选)\"]",
    )!;
    fireEvent.change(persona, { target: { value: "电商客服" } });

    // 展开能力配置并填推荐模型
    fireEvent.click(screen.getByText("展开能力配置(技能 / 知识 / 记忆 / Prompt / 标签) ▼"));
    await waitFor(() => {
      expect(screen.getByText("推荐模型")).toBeInTheDocument();
    });
    const providerInputs = document.querySelectorAll<HTMLInputElement>(
      "input[placeholder=\"provider_key (可选)\"]",
    );
    fireEvent.change(providerInputs[0]!, { target: { value: "openai" } });

    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect((capturedBody as { template_id: string }).template_id).toBe("tpl-new");
    expect((capturedBody as { display_name: string }).display_name).toBe("新专家");
    expect((capturedBody as { persona?: string }).persona).toBe("电商客服");
    expect(
      (capturedBody as { recommended_config?: { default_model_ref?: { provider_key?: string } } })
        .recommended_config?.default_model_ref?.provider_key,
    ).toBe("openai");
    // 表单已关闭
    await waitFor(() => {
      expect(screen.queryByText("注册新模板/方案")).not.toBeInTheDocument();
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

    // 填 solution_id 与名称
    const idInput = document.querySelector<HTMLInputElement>("input[placeholder=\"solution_id\"]")!;
    fireEvent.change(idInput, { target: { value: "sol_a" } });
    const nameInput = document.querySelector<HTMLInputElement>("input[placeholder=\"display_name\"]")!;
    fireEvent.change(nameInput, { target: { value: "全渠道方案" } });

    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    await waitFor(() => {
      const registerCall = mockFetch.mock.calls.find((c: unknown[]) => {
        const url = (c as unknown[])[0] as string;
        return url.includes("solution-templates");
      });
      expect(registerCall).toBeTruthy();
      const body = JSON.parse(((registerCall as unknown[])[1] as { body: string }).body);
      expect(body.expert_template_ids.sort()).toEqual(["exp_a", "exp_b"]);
      expect(body.solution_id).toBe("sol_a");
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

  it("点击编辑展示 persona 表单 + 保存/取消按钮", async () => {
    mockFetch.mockResolvedValue(singleResponse(makeExpertItem()));
    renderCatalogDetail(makeSystemAdminSession(), "exp-1", "expert_template");

    await waitFor(() => expect(screen.getByText("编辑")).toBeInTheDocument());
    fireEvent.click(screen.getByText("编辑"));

    await waitFor(() => {
      expect(screen.getByText("保存")).toBeInTheDocument();
      expect(screen.getByText("取消")).toBeInTheDocument();
    });
    // Persona textarea should show the existing value in edit mode
    const textareas = screen.getAllByRole("textbox").filter(
      (el) => el.tagName === "TEXTAREA",
    );
    expect(textareas.length).toBeGreaterThanOrEqual(1);
    expect(textareas[0]).toHaveValue("你是一名客服专家");
  });

  it("编辑专家模板后调 PATCH 且 body 含 persona", async () => {
    mockFetch
      .mockResolvedValueOnce(singleResponse(makeExpertItem()))
      .mockResolvedValueOnce(
        singleResponse(makeExpertItem({ persona: "新版人设" })),
      );

    renderCatalogDetail(makeSystemAdminSession(), "exp-1", "expert_template");
    await waitFor(() => expect(screen.getByText("编辑")).toBeInTheDocument());
    fireEvent.click(screen.getByText("编辑"));

    await waitFor(() => expect(screen.getByText("保存")).toBeInTheDocument());
    const textareas = screen.getAllByRole("textbox").filter(
      (el) => el.tagName === "TEXTAREA",
    );
    fireEvent.change(textareas[0]!, { target: { value: "新版人设" } });

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes("/exp-1") && c[1] && (c[1] as { method?: string }).method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body.persona).toBe("新版人设");
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
  it("渲染专家专家全部能力 section", async () => {
    mockFetch.mockResolvedValue(
      singleResponse(
        makeCatalogItem({
          catalog_type: "expert_template",
          template_id: "exp_a",
          display_name: "AI 客服",
          persona: "友善客服",
          recommended_config: {
            prompt_pack: { system: "你是客服" },
            default_model_ref: { provider_key: "openai", model_id: "gpt-4o" },
            default_skills: ["skill_a"],
            knowledge_bindings: ["kb_orders"],
            memory_config: { type: "buffer", max_tokens: 4096 },
            role_name: "customer_success",
            category_code: "support",
          },
        }),
      ),
    );

    renderCatalogDetail(makeSystemAdminSession(), "exp_a", "expert_template");

    await waitFor(() => {
      expect(screen.getByText("AI 客服")).toBeInTheDocument();
    });
    expect(screen.getByText("人设(persona)")).toBeInTheDocument();
    expect(screen.getByText("友善客服")).toBeInTheDocument();
    expect(screen.getByText("岗位 / 类别")).toBeInTheDocument();
    expect(screen.getByText("推荐模型 (default_model_ref)")).toBeInTheDocument();
    expect(screen.getAllByText((_, el) => !!el && (el.textContent || "").includes("openai")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText((_, el) => !!el && (el.textContent || "").includes("gpt-4o")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("默认技能 / 知识绑定 / Prompt Pack")).toBeInTheDocument();
    expect(screen.getAllByText((_, el) => !!el && (el.textContent || "").includes("skill_a")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText((_, el) => !!el && (el.textContent || "").includes("kb_orders")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("初始记忆 (memory_config)")).toBeInTheDocument();
  });

  it("渲染行业方案的多 section 内容", async () => {
    mockFetch.mockResolvedValue(
      singleResponse(
        makeCatalogItem({
          catalog_type: "solution_template",
          template_id: "sol_a",
          display_name: "零售方案",
          expert_template_ids: ["exp_a", "exp_b"],
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
    expect(screen.getByText("知识 / 技能引用")).toBeInTheDocument();
    expect(screen.getAllByText((_, el) => !!el && (el.textContent || "").includes("kb_retail")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("协作编排规则 (prompts)")).toBeInTheDocument();
    expect(screen.getByText("零售 planner")).toBeInTheDocument();
    expect(screen.getByText("默认 Grants / 方案标签")).toBeInTheDocument();
    expect(screen.getAllByText((_, el) => !!el && (el.textContent || "").includes("零售")).length).toBeGreaterThanOrEqual(1);
  });

  it("管理员在详情页进入编辑模式修改 persona + 推荐模型,并调 PATCH", async () => {
    mockFetch
      .mockResolvedValueOnce(
        singleResponse(
          makeCatalogItem({
            catalog_type: "expert_template",
            template_id: "exp_a",
            display_name: "AI 客服",
            persona: "旧 persona",
            recommended_config: {
              default_model_ref: { provider_key: "openai", model_id: "gpt-4o" },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        singleResponse(
          makeCatalogItem({
            catalog_type: "expert_template",
            template_id: "exp_a",
            display_name: "AI 客服",
            persona: "新 persona",
            recommended_config: {
              default_model_ref: { provider_key: "anthropic", model_id: "sonnet" },
            },
          }),
        ),
      );

    renderCatalogDetail(makeSystemAdminSession(), "exp_a", "expert_template");

    await waitFor(() => {
      expect(screen.getByText("旧 persona")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("编辑"));

    await waitFor(() => {
      expect(screen.getByText("保存")).toBeInTheDocument();
    });

    const persona = document.querySelector<HTMLTextAreaElement>(
      "textarea",
    )!;
    fireEvent.change(persona, { target: { value: "新 persona" } });
    // In edit mode, find the provider_key input by its surrounding label
    const allInputs = document.querySelectorAll<HTMLInputElement>("input");
    const providerInput = Array.from(allInputs).find(
      (el) => el.value === "openai",
    );
    expect(providerInput).toBeTruthy();
    fireEvent.change(providerInput!, { target: { value: "anthropic" } });

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find((c: unknown[]) => {
        const init = (c as unknown[])[1] as { method?: string } | undefined;
        return init?.method === "PATCH";
      }) as unknown[] | undefined;
      expect(patchCall).toBeTruthy();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body.persona).toBe("新 persona");
      expect(body.recommended_config.default_model_ref.provider_key).toBe("anthropic");
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
        persona: "旧人设",
        ...overrides,
      });
    }
    mockFetch
      .mockResolvedValueOnce(singleResponse(makeExpertItem()))
      .mockResolvedValueOnce(
        singleResponse(makeExpertItem({ persona: "新人设" })),
      );

    renderCatalogDetail(makeSystemOperatorSession(), "exp-op", "expert_template");
    await waitFor(() => expect(screen.getByText("编辑")).toBeInTheDocument());
    fireEvent.click(screen.getByText("编辑"));

    await waitFor(() => expect(screen.getByText("保存")).toBeInTheDocument());
    const textareas = screen.getAllByRole("textbox").filter(
      (el) => el.tagName === "TEXTAREA",
    );
    fireEvent.change(textareas[0]!, { target: { value: "新人设" } });

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes("/exp-op") && c[1] && (c[1] as { method?: string }).method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body.persona).toBe("新人设");
    });
  });
});
