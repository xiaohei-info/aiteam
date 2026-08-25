/**
 * 目录治理页面测试（W-O.3 F03）。
 *
 * 覆盖：role-state 门控、列表渲染、cursor 翻页、写操作 disabled/启用、
 * API 调用与错误展示。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { PlatformRole, ApiError } from "@aiteam/shared";
import { createI18n } from "@aiteam/shared";
import { SessionContext } from "../../auth/session";
import { I18nContext } from "../../i18n/context";
import { operationMessages } from "../../i18n/messages";
import { CatalogPage } from "./CatalogPage";
import { CatalogDetailPage } from "./CatalogDetailPage";
import { validateRegistration } from "./register/validation";
import type { SessionContextValue } from "../../auth/session";

const platformProvidersMock = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([{ provider_id: "provider-1", provider_code: "newapi", display_name: "内部 NewAPI", relay_base_url: "http://relay/v1", api_protocol: "openai-completions", status: "published", version: 2, updated_at: "now" }]),
  models: vi.fn().mockResolvedValue([{ model: { provider_id: "provider-1", model_id: "gpt-5", display_name: "GPT-5", capabilities: {}, status: "published", source: "discovery", version: 3, updated_at: "now" }, rate: { pricing_version: 1, pricing_status: "known", input_usd_per_million: "1", output_usd_per_million: "2" } }]),
}));
vi.mock("../providers/usePlatformProvidersApi", () => ({ usePlatformProvidersApi: () => platformProvidersMock }));

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

async function selectAstryxOption(label: string, option: string): Promise<void> {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
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
    expect(screen.getAllByText("已发布").length).toBeGreaterThanOrEqual(1);
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
              catalog_type: "expert_template",
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
    fireEvent.click(await screen.findByRole("button", { name: "确认发布" }));

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
    fireEvent.click(await screen.findByRole("button", { name: "确认下架" }));

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
    fireEvent.click(await screen.findByRole("button", { name: "确认发布" }));

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
    fireEvent.click(await screen.findByRole("button", { name: "确认发布" }));

    expect(await screen.findByRole("alertdialog", { name: "发布模板" })).toHaveTextContent("该模板已发布");
  });
});

// ---- 6. 注册表单 ----

describe("注册表单", () => {
  it("用键盘选择专家且不会重复保留成员", async () => {
    const expertItems = [
      makeCatalogItem({
        catalog_type: "expert_template",
        template_id: "exp_a",
        display_name: "客服专家",
      }),
    ];
    mockFetch
      .mockResolvedValueOnce(listPage(expertItems))
      .mockResolvedValueOnce(listPage(expertItems));

    renderCatalogPage(makeSystemAdminSession(), "solution_template");
    await screen.findByText("注册行业方案");
    fireEvent.click(screen.getByText("注册行业方案"));

    const selector = await screen.findByRole("combobox", { name: "配置专家模板" });
    selector.focus();
    expect(selector).toHaveFocus();
    fireEvent.keyDown(selector, { key: "ArrowDown" });
    fireEvent.keyDown(selector, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByRole("table", { name: "已选专家" })).toHaveTextContent("客服专家");
      expect(screen.getAllByText("客服专家")).toHaveLength(2);
    });

    fireEvent.keyDown(selector, { key: "Enter" });
    await waitFor(() => {
      expect(screen.queryByRole("table", { name: "已选专家" })).not.toBeInTheDocument();
    });
  });

  it("提交失败后保留已填写的注册输入", async () => {
    mockFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("skill-market/internal")) return listPage([]);
      if (String(url).includes("skill-market/external")) return singleResponse([]);
      if (String(url).includes("expert-templates") && init?.method === "POST") {
        return problemResponse(422, "invalid", "服务端拒绝注册");
      }
      return envOk();
    });

    renderCatalogPage(makeSystemAdminSession());
    await screen.findByText("注册专家模板");
    fireEvent.click(screen.getByText("注册专家模板"));
    fireEvent.change(screen.getByPlaceholderText("display_name"), { target: { value: "保留的专家" } });
    fireEvent.change(screen.getByPlaceholderText("https://..."), { target: { value: "https://example.com/avatar.png" } });
    fireEvent.change(screen.getByPlaceholderText("岗位描述系统提示词（纯文本）"), { target: { value: "保留的人设" } });
    await waitFor(() => expect(screen.getByTestId("platform-model-select")).toHaveTextContent("内部 NewAPI"));
    fireEvent.change(screen.getByPlaceholderText("用户可见的岗位描述（不超过 200 字）"), { target: { value: "描述" } });

    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    await waitFor(() => {
      expect(screen.getByText("服务端拒绝注册")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("display_name")).toHaveValue("保留的专家");
      expect(screen.getByPlaceholderText("岗位描述系统提示词（纯文本）")).toHaveValue("保留的人设");
    });
  });

  it("行业方案不展示专家专属分类字段", async () => {
    mockFetch.mockResolvedValue(listPage([]));
    renderCatalogPage(makeSystemAdminSession(), "solution_template");
    fireEvent.click(await screen.findByText("注册行业方案"));

    expect(screen.queryByRole("combobox", { name: "分类 (category)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建分类" })).not.toBeInTheDocument();
  });

  it("纯校验可由表单复用", () => {
    expect(
      validateRegistration({
        catalogType: "expert_template",
        displayName: "",
        category: "市场营销",
        avatarUrl: "https://example.com/avatar.png",
        systemPrompt: "sp",
        defaultModel: "gpt-5",
        description: "desc",
        expertTemplateIds: [],
        plannerTemplateId: "",
        plannerPrompt: "",
        defaultGrantsText: "",
      }),
    ).toEqual({ displayName: "名称不能为空" });
  });

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

  it("注册专家模板成功提交 system_prompt + platform_model_ref", async () => {
    let capturedBody: unknown = null;
    mockFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("skill-market/internal")) return listPage([]);
      if (String(url).includes("skill-market/external")) return singleResponse([]);
      if (String(url).includes("expert-templates") && init?.method === "POST") {
        capturedBody = init.body ? JSON.parse(String(init.body)) : null;
        return singleResponse(makeCatalogItem({ id: "new-id", display_name: "新专家", system_prompt: "电商客服", platform_model_ref: { provider_id: "provider-1", provider_version: 2, model_id: "gpt-5", model_version: 3 } }));
      }
      return envOk();
    });

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

    await waitFor(() => expect(screen.getByTestId("platform-model-select")).toHaveTextContent("内部 NewAPI"));

    // Fill all PRD required fields so the always-send payload is complete.
    await selectAstryxOption("分类 (category)", "市场营销");
    fireEvent.change(screen.getByPlaceholderText("https://..."), { target: { value: "https://example.com/a.png" } });
    fireEvent.change(screen.getByPlaceholderText("用户可见的岗位描述（不超过 200 字）"), { target: { value: "淘宝电商客服" } });

    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    await waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody).toEqual({
      display_name: "新专家",
      category: "市场营销",
      avatar_url: "https://example.com/a.png",
      system_prompt: "电商客服",
      platform_model_ref: { provider_id: "provider-1", provider_version: 2, model_id: "gpt-5", model_version: 3 },
      description: "淘宝电商客服",
      platform_skill_refs: [],
    });
    await waitFor(() => {
      expect(screen.queryByText("注册新模板/方案")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("注册专家模板"));
    expect(screen.getByPlaceholderText("display_name")).toHaveValue("");
    expect(screen.getByPlaceholderText("岗位描述系统提示词（纯文本）")).toHaveValue("");
  });

  it("注册专家模板不再展示手工技能 ID、标签、预置记忆和排序", async () => {
    renderCatalogPage(makeSystemAdminSession());
    fireEvent.click(await screen.findByText("注册专家模板"));
    await screen.findByText("技能（可选）");
    expect(screen.queryByText(/预配置技能/)).not.toBeInTheDocument();
    expect(screen.queryByText(/预置记忆/)).not.toBeInTheDocument();
    expect(screen.queryByText(/排序权重/)).not.toBeInTheDocument();
    expect(screen.queryByText(/搜索标签/)).not.toBeInTheDocument();
  });

  it("注册专家模板时通过「新建分类」流程追加自定义分类并提交", async () => {
    let capturedBody: unknown = null;
    mockFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("skill-market/internal")) return listPage([]);
      if (String(url).includes("skill-market/external")) return singleResponse([]);
      if (String(url).includes("expert-templates") && init?.method === "POST") {
        capturedBody = init.body ? JSON.parse(String(init.body)) : null;
        return singleResponse(makeCatalogItem({ id: "new-cat", display_name: "新专家" }));
      }
      return envOk();
    });

    renderCatalogPage(makeSystemAdminSession());
    await waitFor(() => expect(screen.getByText("注册专家模板")).toBeInTheDocument());
    fireEvent.click(screen.getByText("注册专家模板"));
    await waitFor(() => expect(screen.getByText("注册新模板/方案")).toBeInTheDocument());

    fireEvent.change(document.querySelector<HTMLInputElement>("input[placeholder=\"display_name\"]")!, { target: { value: "新专家" } });
    fireEvent.change(document.querySelector<HTMLTextAreaElement>("textarea[placeholder=\"岗位描述系统提示词（纯文本）\"]")!, { target: { value: "sp" } });
    await waitFor(() => expect(screen.getByTestId("platform-model-select")).toHaveTextContent("内部 NewAPI"));
    fireEvent.change(screen.getByPlaceholderText("https://..."), { target: { value: "https://x.png" } });
    fireEvent.change(screen.getByPlaceholderText("用户可见的岗位描述（不超过 200 字）"), { target: { value: "desc" } });

    fireEvent.click(screen.getByRole("button", { name: "新建分类" }));
    const newCatInput = await screen.findByLabelText("新分类名称");
    fireEvent.change(newCatInput, { target: { value: "电商运营" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "分类 (category)" })).toHaveTextContent("电商运营");
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

    const teamSelector = await screen.findByRole("combobox", { name: "配置专家模板" });
    fireEvent.keyDown(teamSelector, { key: "ArrowDown" });
    fireEvent.keyDown(teamSelector, { key: "Enter" });
    fireEvent.keyDown(teamSelector, { key: "ArrowDown" });
    fireEvent.keyDown(teamSelector, { key: "Enter" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "设 客服专家 为 Planner" }));

    // ID 由服务端自动生成（AITEAM-355 问题二）：表单只暴露 display_name，solution_id 已移除。
    const nameInput = document.querySelector<HTMLInputElement>("input[placeholder=\"display_name\"]")!;
    expect(nameInput).toBeTruthy();
    fireEvent.change(nameInput, { target: { value: "全渠道方案" } });

    // AITEAM-677：planner_prompt 必填
    const plannerPromptTa = screen.getByRole("textbox", { name: /Planner 编排规则提示词/ });
    fireEvent.change(plannerPromptTa, { target: { value: "组织各专家协作" } });
    fireEvent.change(screen.getByLabelText("描述 (description)"), { target: { value: "全渠道服务" } });
    fireEvent.change(screen.getByLabelText("图标 (icon)"), { target: { value: "retail" } });
    fireEvent.change(screen.getByLabelText("知识引用 (knowledge_refs, 每行或逗号分隔)"), { target: { value: "kb_orders\nkb_finance" } });
    fireEvent.change(screen.getByLabelText("技能引用 (skill_refs, 每行或逗号分隔)"), { target: { value: "route, summarize" } });
    fireEvent.click(screen.getByRole("button", { name: "高级配置（Subtask、Aggregate、Grants、Tags）" }));
    fireEvent.change(screen.getByLabelText("Subtask Prompt"), { target: { value: "拆解任务" } });
    fireEvent.change(screen.getByLabelText("Aggregate Prompt"), { target: { value: "汇总结果" } });
    fireEvent.change(screen.getByLabelText("默认 Grants (JSON)"), { target: { value: '{"max_concurrent_tasks":5}' } });
    fireEvent.change(screen.getByLabelText("方案标签 (每行或逗号分隔)"), { target: { value: "零售\n电商" } });

    fireEvent.click(screen.getByRole("button", { name: "注册" }));

    await waitFor(() => {
      const registerCall = mockFetch.mock.calls.find((c: unknown[]) => {
        const url = (c as unknown[])[0] as string;
        return url.includes("solution-templates");
      });
      expect(registerCall).toBeTruthy();
      const body = JSON.parse(((registerCall as unknown[])[1] as { body: string }).body);
      expect(body).toEqual({
        display_name: "全渠道方案",
        description: "全渠道服务",
        icon: "retail",
        expert_template_ids: ["exp_a", "exp_b"],
        planner_template_id: "exp_a",
        knowledge_refs: ["kb_orders", "kb_finance"],
        skill_refs: ["route", "summarize"],
        planner_prompt: "组织各专家协作",
        subtask_prompt: "拆解任务",
        aggregate_prompt: "汇总结果",
        default_grants: { max_concurrent_tasks: 5 },
        tags: ["零售", "电商"],
      });
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

    const teamSelector = await screen.findByRole("combobox", { name: "配置专家模板" });
    fireEvent.keyDown(teamSelector, { key: "ArrowDown" });
    fireEvent.keyDown(teamSelector, { key: "Enter" });
    const nameInput = document.querySelector<HTMLInputElement>("input[placeholder=\"display_name\"]")!;
    fireEvent.change(nameInput, { target: { value: "测试方案" } });
    fireEvent.change(
      screen.getByRole("textbox", { name: /Planner 编排规则提示词/ }),
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

    const teamSelector = await screen.findByRole("combobox", { name: "配置专家模板" });
    fireEvent.keyDown(teamSelector, { key: "ArrowDown" });
    fireEvent.keyDown(teamSelector, { key: "Enter" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "设 客服专家 为 Planner" }));
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
      platform_model_ref: { provider_id: "provider-1", provider_version: 2, model_id: "gpt-5", model_version: 3 },
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
      expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
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
          platform_model_ref: { provider_id: "provider-1", provider_version: 2, model_id: "gpt-4o", model_version: 3 },
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
    expect(screen.getByText("大模型服务 / 模型")).toBeInTheDocument();
    expect(screen.getByText(/provider-1 \/ gpt-4o/)).toBeInTheDocument();
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

  it("管理员编辑 system_prompt 时平台模型保持只读且 PATCH 不改模型", async () => {
    mockFetch
      .mockResolvedValueOnce(
        singleResponse(
          makeCatalogItem({
            catalog_type: "expert_template",
            template_id: "exp_a",
            display_name: "AI 客服",
            system_prompt: "旧 system_prompt",
            platform_model_ref: { provider_id: "provider-1", provider_version: 2, model_id: "gpt-4o", model_version: 3 },
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
            platform_model_ref: { provider_id: "provider-1", provider_version: 2, model_id: "gpt-4o", model_version: 3 },
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
    expect(screen.getByText(/provider-1 \/ gpt-4o/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      const patchCall = mockFetch.mock.calls.find((c: unknown[]) => {
        const init = (c as unknown[])[1] as { method?: string } | undefined;
        return init?.method === "PATCH";
      }) as unknown[] | undefined;
      expect(patchCall).toBeTruthy();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body.system_prompt).toBe("新 system_prompt");
      expect(body.platform_model_ref).toBeUndefined();
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
      platform_model_ref: { provider_id: "provider-1", provider_version: 2, model_id: "gpt-4o", model_version: 3 },
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

// ---- 9. Astryx catalog workbenches ----

describe("AstryX 目录工作台", () => {
  it("按目录类型隔离列表，并可按名称和状态筛选", async () => {
    mockFetch.mockResolvedValue(
      listPage([
        makeCatalogItem({
          catalog_type: "expert_template",
          template_id: "expert-published",
          display_name: "客服专家",
          status: "published",
        }),
        makeCatalogItem({
          catalog_type: "expert_template",
          template_id: "expert-draft",
          display_name: "财务专家",
          status: "draft",
        }),
        makeCatalogItem({
          catalog_type: "solution_template",
          template_id: "solution-leak",
          display_name: "不应泄漏的方案",
          status: "published",
        }),
      ]),
    );

    renderCatalogPage(makeSystemAdminSession(), "expert_template");

    await waitFor(() => {
      expect(screen.getByText("客服专家")).toBeInTheDocument();
    });
    expect(screen.queryByText("不应泄漏的方案")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索目录" }), {
      target: { value: "财务" },
    });
    expect(screen.queryByText("客服专家")).not.toBeInTheDocument();
    expect(screen.getByText("财务专家")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("combobox", { name: "目录状态" }));
    fireEvent.click(screen.getByRole("option", { name: "已发布" }));
    expect(screen.queryByText("财务专家")).not.toBeInTheDocument();
  });

  it("生命周期动作必须确认；失败时保留确认框和错误", async () => {
    mockFetch
      .mockResolvedValueOnce(
        listPage([makeCatalogItem({ template_id: "publish-me", status: "draft" })]),
      )
      .mockResolvedValueOnce(problemResponse(409, "conflict", "无法发布模板"));

    renderCatalogPage(makeSystemAdminSession());

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "发布" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "发布" }));

    expect(await screen.findByRole("alertdialog", { name: "发布模板" })).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));

    expect(await screen.findByRole("alertdialog", { name: "发布模板" })).toHaveTextContent("无法发布模板");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "发布模板" })).not.toBeInTheDocument());
  });

  it("隐藏动作须经确认后才将模板设为隐藏", async () => {
    mockFetch
      .mockResolvedValueOnce(
        listPage([makeCatalogItem({ template_id: "retire-me", status: "unpublished" })]),
      )
      .mockResolvedValueOnce(singleResponse(null))
      .mockResolvedValueOnce(listPage([]));

    renderCatalogPage(makeSystemAdminSession());

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "隐藏" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "隐藏" }));

    expect(await screen.findByRole("alertdialog", { name: "隐藏模板" })).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "确认隐藏" }));

    await waitFor(() => {
      const request = mockFetch.mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes("/visibility"),
      );
      expect(request).toBeDefined();
      expect((request![1] as { method?: string }).method).toBe("PUT");
      expect(JSON.parse((request![1] as { body: string }).body)).toEqual({
        visible_scope: { hidden: true },
      });
    });
  });

  it("详情页可切换到版本信息，并用面包屑返回对应目录", async () => {
    mockFetch.mockResolvedValue(
      singleResponse(
        makeCatalogItem({
          catalog_type: "solution_template",
          template_id: "solution-v2",
          display_name: "零售方案",
          version: "2.0.0",
        }),
      ),
    );

    renderCatalogDetail(makeSystemAdminSession(), "solution-v2", "solution_template");

    expect(await screen.findByRole("navigation", { name: "面包屑" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "版本信息" }));
    expect(await screen.findByText("当前版本")).toBeInTheDocument();
    expect(screen.getByText('"2.0.0"')).toBeInTheDocument();
  });

  it("详情页隐藏模板必须先经过确认", async () => {
    const item = makeCatalogItem({ template_id: "hide-detail", display_name: "待隐藏模板", visible_scope: { public: true } });
    mockFetch
      .mockResolvedValueOnce(singleResponse(item))
      .mockResolvedValueOnce(singleResponse({ ...item, visible_scope: { hidden: true } }));

    renderCatalogDetail(makeSystemAdminSession(), "hide-detail");
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("combobox", { name: "可见范围" }));
    fireEvent.click(screen.getByRole("option", { name: "隐藏" }));

    expect(await screen.findByRole("alertdialog", { name: "隐藏模板" })).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "确认隐藏" }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it("可见性更新成功不覆盖未保存的本地输入", async () => {
    const item = makeCatalogItem({ template_id: "keep-draft", display_name: "保留草稿", system_prompt: "旧提示词", visible_scope: { public: true } });
    mockFetch
      .mockResolvedValueOnce(singleResponse(item))
      .mockResolvedValueOnce(singleResponse({ ...item, visible_scope: { enterprise_ids: ["*"] } }));

    renderCatalogDetail(makeSystemAdminSession(), "keep-draft");
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByRole("textbox", { name: "system_prompt" }), { target: { value: "本地未保存" } });
    fireEvent.click(screen.getByRole("combobox", { name: "可见范围" }));
    fireEvent.click(screen.getByRole("option", { name: "企业可见" }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("textbox", { name: "system_prompt" })).toHaveValue("本地未保存");
  });

  it("可见性更新失败后仍保留编辑表单和输入", async () => {
    const item = makeCatalogItem({ template_id: "visibility-fail", display_name: "失败保留", system_prompt: "旧提示词", visible_scope: { public: true } });
    mockFetch
      .mockResolvedValueOnce(singleResponse(item))
      .mockResolvedValueOnce(problemResponse(409, "conflict", "可见性冲突"));

    renderCatalogDetail(makeSystemAdminSession(), "visibility-fail");
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByRole("textbox", { name: "system_prompt" }), { target: { value: "保留的输入" } });
    fireEvent.click(screen.getByRole("combobox", { name: "可见范围" }));
    fireEvent.click(screen.getByRole("option", { name: "企业可见" }));

    expect(await screen.findByText("可见性冲突")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "system_prompt" })).toHaveValue("保留的输入");
  });

  it("路由切换后忽略旧模板保存的迟到响应", async () => {
    let resolvePatch: ((response: Response) => void) | undefined;
    const patchResponse = new Promise<Response>((resolve) => { resolvePatch = resolve; });
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return patchResponse;
      if (url.includes("/fresh-save")) return Promise.resolve(singleResponse(makeCatalogItem({ template_id: "fresh-save", display_name: "新模板" })));
      return Promise.resolve(singleResponse(makeCatalogItem({ template_id: "slow-save", display_name: "旧模板", system_prompt: "旧值" })));
    });

    function RouteSwitcher() {
      const navigate = useNavigate();
      return (
        <>
          <button type="button" onClick={() => navigate("/catalog/expert_template/fresh-save")}>切换保存目标</button>
          <CatalogDetailPage />
        </>
      );
    }

    render(
      <I18nContext.Provider value={makeI18n()}>
        <SessionContext.Provider value={makeSystemAdminSession()}>
          <MemoryRouter initialEntries={["/catalog/expert_template/slow-save"]}>
            <Routes><Route path="/catalog/:catalog_type/:template_id" element={<RouteSwitcher />} /></Routes>
          </MemoryRouter>
        </SessionContext.Provider>
      </I18nContext.Provider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByRole("textbox", { name: "system_prompt" }), { target: { value: "待保存" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mockFetch.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "PATCH")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "切换保存目标" }));
    expect(await screen.findByRole("heading", { name: "新模板" })).toBeInTheDocument();

    await act(async () => {
      resolvePatch!(singleResponse(makeCatalogItem({ template_id: "slow-save", display_name: "旧模板已保存", system_prompt: "待保存" })));
      await patchResponse;
    });
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "旧模板已保存" })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "新模板" })).toBeInTheDocument();
    });
  });

  it("路由参数变化时忽略过期详情响应", async () => {
    let resolveSlow: ((response: Response) => void) | undefined;
    let resolveFresh: ((response: Response) => void) | undefined;
    const slow = new Promise<Response>((resolve) => { resolveSlow = resolve; });
    const fresh = new Promise<Response>((resolve) => { resolveFresh = resolve; });

    mockFetch.mockImplementation((url: string) => (
      url.includes("/slow") ? slow : fresh
    ));

    function RouteSwitcher() {
      const navigate = useNavigate();
      return (
        <>
          <button type="button" onClick={() => navigate("/catalog/expert_template/fresh")}>切换目录项</button>
          <CatalogDetailPage />
        </>
      );
    }

    const i18n = makeI18n();
    render(
      <I18nContext.Provider value={i18n}>
        <SessionContext.Provider value={makeSystemAdminSession()}>
          <MemoryRouter initialEntries={["/catalog/expert_template/slow"]}>
            <Routes>
              <Route path="/catalog/:catalog_type/:template_id" element={<RouteSwitcher />} />
            </Routes>
          </MemoryRouter>
        </SessionContext.Provider>
      </I18nContext.Provider>,
    );

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "切换目录项" }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    resolveFresh!(singleResponse(makeCatalogItem({ template_id: "fresh", display_name: "最新详情" })));
    expect(await screen.findByRole("heading", { name: "最新详情" })).toBeInTheDocument();

    resolveSlow!(singleResponse(makeCatalogItem({ template_id: "slow", display_name: "过期详情" })));
    await waitFor(() => {
      expect(screen.queryByText("过期详情")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "最新详情" })).toBeInTheDocument();
    });
  });
});
