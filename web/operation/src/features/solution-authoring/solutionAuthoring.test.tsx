import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { DraftDetailPage } from "./DraftDetailPage";
import { findingField, jobError } from "./labels";
import { SolutionAuthoringPage } from "./SolutionAuthoringPage";
import type { DraftDetail, DraftStatus, DraftSummary, Finding } from "./types";

const BASE = "/api/operation/solution-authoring/drafts";
const DRAFT_ID = "11111111-1111-4111-8111-111111111111";

function session(role: string): SessionContextValue {
  return {
    session: {
      principal: { id: "u1", display_name: "运营", status: "active", roles: [role] },
      claims: { user_id: "u1", roles: [role], exp: Math.floor(Date.now() / 1000) + 3600 },
    },
    token: "token",
    signIn: () => {},
    signOut: () => {},
    onUnauthorized: () => {},
  };
}

const SUMMARY: DraftSummary = {
  draft_id: DRAFT_ID, title: "质检方案", status: "ready_for_review",
  platform_model_ref: { provider_id: "provider-1", model_id: "model-1" }, image_recognition: "none", version: 3,
  published_solution_id: null, created_by: "u1", updated_by: "u1",
  created_at: "2026-11-12T08:00:00Z", updated_at: "2026-11-12T08:05:00Z",
};

const PHONE_FINDING: Finding = {
  finding_id: "f-phone", kind: "phone", origin: "rule", field_path: "experts[0].system_prompt", masked: "1********1",
  locator: "", note: "", status: "open", resolved_by: null, resolved_at: null, created_at: "2026-11-12T08:05:00Z",
};
const IMAGE_FINDING: Finding = {
  finding_id: "f-image", kind: "image_unrecognized", origin: "system", field_path: "", masked: "",
  locator: "流程图.png · 图片", note: "recognition_disabled", status: "open", resolved_by: null, resolved_at: null,
  created_at: "2026-11-12T08:05:00Z",
};

function detail(overrides: Partial<DraftDetail> = {}): DraftDetail {
  const findings = overrides.findings ?? [PHONE_FINDING, IMAGE_FINDING];
  return {
    ...SUMMARY,
    supplement: "",
    package: {
      display_name: "来料质检方案", description: "覆盖来料检验。", tags: ["质检"], coordinator_key: "lead",
      coordinator_instructions: "先拆解再分派。", output_requirements: "列出依据。",
      experts: [
        { key: "lead", display_name: "质检协调专家", category: "质量管理", description: "统筹质检任务。", system_prompt: "你是质检协调专家。", evidence: [{ chunk_id: "s1-c1", quote: "来料检验流程" }] },
        { key: "inspector", display_name: "检验专家", category: "质量管理", description: "执行来料检验。", system_prompt: "你是检验专家。", evidence: [] },
      ],
      evidence: [{ chunk_id: "s1-c1" }],
    },
    evidence_sources: { "s1-c1": { source_name: "质量手册.md", locator: "第 1 段", excerpt: "来料检验流程……", origin: "image", low_confidence: true } },
    warnings: [], prompt_version: "v1", usage: { total_tokens: 100 }, review_note: "",
    sources: [{ source_id: "s-1", file_name: "质量手册.md", size_bytes: 2048, status: "parsed", error_code: null, chunk_count: 3, image_count: 1, warnings: ["text_truncated"], created_at: "2026-11-12T08:01:00Z" }],
    findings,
    open_finding_count: findings.filter((item) => item.status === "open").length,
    events: [{ action: "created", actor_id: "u1", summary: "", created_at: "2026-11-12T08:00:00Z" }],
    latest_job: null,
    ...overrides,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(status < 400 ? { data } : data), {
    status, headers: { "content-type": status < 400 ? "application/json" : "application/problem+json" },
  });
}

interface Call { method: string; path: string; headers: Headers; body: unknown; }

/** 按「METHOD 路径」分发的 fetch 桩；记录每次调用。 */
function mockApi(routes: Record<string, (call: Call) => Response>): Call[] {
  const calls: Call[] = [];
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const call: Call = {
      method: init?.method ?? "GET", path: String(input), headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    if (!handler) return json({ status: 404, code: "not_found", title: "Not Found", detail: `no stub for ${call.method} ${call.path}` }, 404);
    return handler(call);
  });
  return calls;
}

function renderDetail(role = "system_operator") {
  return render(
    <SessionContext.Provider value={session(role)}>
      <MemoryRouter initialEntries={[`/solution-authoring/${DRAFT_ID}`]}>
        <Routes>
          <Route path="/solution-authoring" element={<div>列表页</div>} />
          <Route path="/solution-authoring/:draft_id" element={<DraftDetailPage />} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}

function renderList() {
  return render(
    <SessionContext.Provider value={session("system_operator")}>
      <MemoryRouter initialEntries={["/solution-authoring"]}>
        <Routes>
          <Route path="/solution-authoring" element={<SolutionAuthoringPage />} />
          <Route path="/solution-authoring/:draft_id" element={<div>详情页</div>} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}

/** Astryx 按钮用 aria-disabled 表示禁用（保留焦点与提示），不设原生 disabled。 */
function isDisabled(element: HTMLElement): boolean {
  return element.getAttribute("aria-disabled") === "true" || (element as HTMLButtonElement).disabled === true;
}

beforeEach(() => { globalThis.fetch = vi.fn(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("SolutionAuthoringPage", () => {
  it("列出草稿并显示中文状态", async () => {
    mockApi({ [`GET ${BASE}`]: () => json([SUMMARY]) });
    renderList();
    const table = await screen.findByRole("table", { name: "方案草稿" });
    expect(within(table).getByRole("link", { name: "质检方案" })).toHaveAttribute("href", `/solution-authoring/${DRAFT_ID}`);
    expect(within(table).getByText("待处理")).toBeInTheDocument();
    expect(within(table).getByText("model-1")).toBeInTheDocument();
  });

  it("空列表、加载失败与重试", async () => {
    mockApi({ [`GET ${BASE}`]: () => json([]) });
    const empty = renderList();
    expect(await screen.findByText("还没有草稿")).toBeInTheDocument();
    empty.unmount();

    vi.mocked(globalThis.fetch)
      .mockReset()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(json([SUMMARY]));
    renderList();
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("link", { name: "质检方案" })).toBeInTheDocument();
  });
});

const PROVIDERS = "/api/operation/providers";
const PROVIDER = {
  provider_id: "provider-1", provider_code: "newapi", display_name: "LLM 网关", relay_base_url: "https://relay.example.invalid/v1",
  api_protocol: "openai-completions", status: "published", version: 1, updated_at: "2026-11-12T08:00:00Z",
};

function platformModel(modelId: string, input: string[], status = "published", priced = true) {
  return {
    model: { provider_id: "provider-1", model_id: modelId, display_name: modelId, capabilities: { input }, status, source: "discovery", version: 1, updated_at: "2026-11-12T08:00:00Z" },
    rate: priced ? { pricing_status: "known" } : null,
  };
}

const MODEL_ROUTES = {
  [`GET ${PROVIDERS}`]: () => json([PROVIDER, { ...PROVIDER, provider_id: "provider-off", display_name: "停用的服务", status: "disabled" }]),
  [`GET ${PROVIDERS}/provider-1/models`]: () => json({
    items: [
      platformModel("vision-model", ["text", "image"]),
      platformModel("text-model", ["text"]),
      platformModel("draft-model", ["text"], "draft"),
      platformModel("unpriced-model", ["text"], "published", false),
    ],
  }),
};

async function openCreateDialog(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "新建草稿" }));
  return screen.findByRole("dialog", { name: "新建方案草稿" });
}

async function choose(label: RegExp, option: RegExp): Promise<void> {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option, hidden: true }));
}

describe("CreateDraftDialog", () => {
  it("只列已发布且有价格的模型；校验通过后创建并进入草稿页", async () => {
    const calls = mockApi({
      [`GET ${BASE}`]: () => json([]),
      ...MODEL_ROUTES,
      [`POST ${BASE}`]: () => json(SUMMARY, 201),
    });
    renderList();
    const dialog = await openCreateDialog();
    const modelBox = within(dialog).getByRole("combobox", { name: /生成模型/ });
    await waitFor(() => expect(modelBox).toHaveTextContent("选择已发布的平台模型"));
    // 停用的服务不去拉它的模型。
    expect(calls.some((call) => call.path.includes("provider-off"))).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    expect(await screen.findByText("请填写标题并选择模型")).toBeInTheDocument();

    fireEvent.click(modelBox);
    // 页面上还有「图片识别」下拉的选项，这里只看模型的。
    const options = (await screen.findAllByRole("option", { name: /LLM 网关/, hidden: true })).map((option) => option.textContent);
    expect(options).toEqual(["LLM 网关 / vision-model · 支持图片", "LLM 网关 / text-model"]);
    fireEvent.click(screen.getByRole("option", { name: /text-model/, hidden: true }));

    fireEvent.change(within(dialog).getByRole("textbox", { name: /标题/ }), { target: { value: "  注塑质检方案  " } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /补充说明/ }), { target: { value: " 侧重来料检验 " } });
    await choose(/图片识别/, /用所选模型识别图片/);
    expect(await screen.findByText("所选模型不支持图片输入")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    expect(await screen.findByText("所选模型不支持图片输入，请换一个模型或关闭图片识别")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "POST")).toBe(false);

    await choose(/生成模型/, /vision-model/);
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    expect(await screen.findByText("详情页")).toBeInTheDocument();
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      title: "注塑质检方案", platform_model_ref: { provider_id: "provider-1", model_id: "vision-model" },
      image_recognition: "vision", supplement: "侧重来料检验",
    });
  });

  it("创建被拒绝时留在对话框并显示原因；取消后关闭", async () => {
    mockApi({
      [`GET ${BASE}`]: () => json([]),
      ...MODEL_ROUTES,
      [`POST ${BASE}`]: () => json({ status: 409, code: "conflict", title: "Conflict", detail: "所选模型已下架" }, 409),
    });
    renderList();
    const dialog = await openCreateDialog();
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: /生成模型/ })).toHaveTextContent("选择已发布的平台模型"));
    await choose(/生成模型/, /text-model/);
    fireEvent.change(within(dialog).getByRole("textbox", { name: /标题/ }), { target: { value: "质检方案" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    expect(await screen.findByText("所选模型已下架")).toBeInTheDocument();
    expect(screen.queryByText("详情页")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建方案草稿" })).not.toBeInTheDocument());
  });

  it("没有可用模型时给出去处；模型列表加载失败时显示原因", async () => {
    mockApi({
      [`GET ${BASE}`]: () => json([]),
      [`GET ${PROVIDERS}`]: () => json([PROVIDER]),
      [`GET ${PROVIDERS}/provider-1/models`]: () => json({ items: [platformModel("draft-model", ["text"], "draft")] }),
    });
    const empty = renderList();
    await openCreateDialog();
    expect(await screen.findByText("没有可用的模型")).toBeInTheDocument();
    empty.unmount();

    mockApi({
      [`GET ${BASE}`]: () => json([]),
      [`GET ${PROVIDERS}`]: () => json({ status: 503, code: "service_unavailable", title: "Service Unavailable", detail: "平台模型目录暂不可用" }, 503),
    });
    renderList();
    await openCreateDialog();
    expect(await screen.findByText("平台模型目录暂不可用")).toBeInTheDocument();
    expect(screen.queryByText("没有可用的模型")).not.toBeInTheDocument();
  });
});

describe("findingField", () => {
  it("把字段路径说成页面上的位置；认不出的原样显示", () => {
    const solution = detail().package;
    expect(findingField("output_requirements", solution)).toBe("交付要求");
    expect(findingField("tags[2]", solution)).toBe("标签");
    expect(findingField("experts[1].description", solution)).toBe("专家「检验专家」的岗位描述");
    expect(findingField("experts[5].category", solution)).toBe("第 6 位专家的分类");
    expect(findingField("experts[0].system_prompt", null)).toBe("第 1 位专家的系统提示词");
    expect(findingField("experts[0].unknown", solution)).toBe("experts[0].unknown");
    expect(findingField("something_else", solution)).toBe("something_else");
  });
});

describe("DraftDetailPage", () => {
  it("展示资料、正文、依据与敏感项，只显示脱敏片段", async () => {
    mockApi({ [`GET ${BASE}/${DRAFT_ID}`]: () => json(detail()) });
    renderDetail();
    expect(await screen.findByRole("heading", { level: 1, name: "质检方案" })).toBeInTheDocument();
    expect(screen.getByText(/2 KB · 3 段文字 · 1 张图片/)).toBeInTheDocument();
    expect(screen.getByText("文字过长，超出部分未读取")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "来料质检方案" })).toBeInTheDocument();
    expect(screen.getAllByText("识别置信度低，请核对原图").length).toBeGreaterThan(0);

    const findings = screen.getByRole("list", { name: "敏感项清单" });
    expect(within(findings).getByText("1********1")).toBeInTheDocument();
    expect(within(findings).getByText("电话号码")).toBeInTheDocument();
    expect(within(findings).getByText(/未开启图片识别/)).toBeInTheDocument();
    // 命中位置说成编辑页上的字段名，而不是后端的字段路径。
    expect(within(findings).getByText(/出现在正文：专家「质检协调专家」的系统提示词/)).toBeInTheDocument();
    expect(within(findings).queryByText(/experts\[0\]/)).not.toBeInTheDocument();
    expect(screen.getByText("2 项待处理")).toBeInTheDocument();
    // 正文里的项给三种处理方式；不在正文里的只能确认已知悉。
    expect(within(findings).getAllByRole("button").map((button) => button.textContent)).toEqual(["脱敏", "从正文删除", "确认可公开", "确认已知悉"]);
  });

  it("有待处理项时不能提交审核；处理后采用服务端返回的新详情", async () => {
    const resolved = detail({ version: 4, findings: [{ ...PHONE_FINDING, status: "redacted" }, { ...IMAGE_FINDING, status: "acknowledged" }] });
    const calls = mockApi({
      [`GET ${BASE}/${DRAFT_ID}`]: () => json(detail()),
      [`POST ${BASE}/${DRAFT_ID}/findings/f-phone/resolve`]: () => json(resolved),
      [`POST ${BASE}/${DRAFT_ID}/submit-review`]: () => json({ ...resolved, status: "in_review" as DraftStatus }),
    });
    renderDetail();
    expect(isDisabled(await screen.findByRole("button", { name: "提交审核" }))).toBe(true);
    // 禁用状态下点击不会发出请求。
    fireEvent.click(screen.getByRole("button", { name: "提交审核" }));
    expect(calls.some((call) => call.path.endsWith("/submit-review"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "脱敏" }));
    await waitFor(() => expect(isDisabled(screen.getByRole("button", { name: "提交审核" }))).toBe(false));
    expect(calls.find((call) => call.path.endsWith("/resolve"))?.body).toEqual({ resolution: "redact" });
    expect(screen.getByText("已脱敏")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "提交审核" }));
    expect(await screen.findByText("等待管理员审核")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑正文" })).not.toBeInTheDocument();
  });

  it("审核通过、驳回与发布只对系统管理员显示", async () => {
    mockApi({ [`GET ${BASE}/${DRAFT_ID}`]: () => json(detail({ status: "in_review", findings: [] })) });
    const operator = renderDetail("system_operator");
    await screen.findByRole("heading", { level: 1, name: "质检方案" });
    expect(screen.queryByRole("button", { name: "审核通过" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "驳回" })).not.toBeInTheDocument();
    operator.unmount();

    const calls = mockApi({
      [`GET ${BASE}/${DRAFT_ID}`]: () => json(detail({ status: "in_review", findings: [] })),
      [`POST ${BASE}/${DRAFT_ID}/approve`]: () => json(detail({ status: "approved", findings: [] })),
    });
    renderDetail("system_admin");
    fireEvent.click(await screen.findByRole("button", { name: "审核通过" }));
    expect(await screen.findByRole("button", { name: "发布到目录" })).toBeInTheDocument();
    expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/approve"))).toBe(true);
  });

  it("上传走 multipart，发起生成带幂等键", async () => {
    const calls = mockApi({
      [`GET ${BASE}/${DRAFT_ID}`]: () => json(detail({ status: "draft", package: null, findings: [] })),
      [`POST ${BASE}/${DRAFT_ID}/sources`]: () => json({ source_id: "s-2" }, 201),
      [`POST ${BASE}/${DRAFT_ID}/generate`]: () => json({ job_id: "j-1", status: "queued" }, 202),
    });
    renderDetail();
    const input = await screen.findByLabelText("选择资料文件");
    fireEvent.change(input, { target: { files: [new File(["内容"], "新资料.md", { type: "text/markdown" })] } });
    await waitFor(() => expect(calls.some((call) => call.path.endsWith("/sources"))).toBe(true));
    const upload = calls.find((call) => call.path.endsWith("/sources"))!;
    expect(upload.body).toBeInstanceOf(FormData);
    expect(((upload.body as FormData).get("file") as File).name).toBe("新资料.md");
    expect(upload.headers.get("Content-Type")).toBeNull();

    await waitFor(() => expect(isDisabled(screen.getByRole("button", { name: "开始生成" }))).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith("/generate"))).toBe(true));
    expect(calls.find((call) => call.path.endsWith("/generate"))!.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("编辑正文时带上所基于的版本；版本冲突给出提示并重新拉取", async () => {
    let gets = 0;
    const calls = mockApi({
      [`GET ${BASE}/${DRAFT_ID}`]: () => { gets += 1; return json(detail({ findings: [] })); },
      [`PUT ${BASE}/${DRAFT_ID}/package`]: () => json({ status: 409, code: "conflict", title: "Conflict", detail: "draft was modified by someone else; reload and retry" }, 409),
    });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "编辑正文" }));
    fireEvent.change(screen.getByLabelText(/方案名称/), { target: { value: "新名称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findAllByText(/modified by someone else/)).length).toBeGreaterThan(0);
    const put = calls.find((call) => call.method === "PUT")!;
    expect(put.body).toMatchObject({ version: 3, package: { display_name: "新名称", coordinator_key: "lead" } });
    await waitFor(() => expect(gets).toBe(2));
  });

  it("归档需要二次确认，成功后回到列表", async () => {
    const calls = mockApi({
      [`GET ${BASE}/${DRAFT_ID}`]: () => json(detail({ findings: [] })),
      [`DELETE ${BASE}/${DRAFT_ID}`]: () => new Response(null, { status: 204 }),
    });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: "归档" }));
    expect(await screen.findByText(/已上传的资料原件会被删除/)).toBeInTheDocument();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));
    expect(await screen.findByText("列表页")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  it("生成失败显示可读的原因；已发布显示目录入口", async () => {
    const failedJob = { job_id: "j-1", status: "failed" as const, attempt: 1, error_code: "budget_exceeded", error_message: "exceeded 60 turns", usage: {}, created_at: "2026-11-12T08:02:00Z", started_at: null, finished_at: null };
    mockApi({ [`GET ${BASE}/${DRAFT_ID}`]: () => json(detail({ status: "draft", package: null, findings: [], latest_job: failedJob })) });
    const failed = renderDetail();
    expect(await screen.findByText("上一次生成失败")).toBeInTheDocument();
    expect(screen.getByText(jobError("budget_exceeded"))).toBeInTheDocument();
    failed.unmount();

    mockApi({ [`GET ${BASE}/${DRAFT_ID}`]: () => json(detail({ status: "published", findings: [], published_solution_id: "sa-abc" })) });
    renderDetail("system_admin");
    expect(await screen.findByRole("link", { name: "查看目录项" })).toHaveAttribute("href", "/catalog/solution_template/sa-abc");
    expect(screen.queryByRole("button", { name: "上传资料" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑正文" })).not.toBeInTheDocument();
  });
});

describe("labels", () => {
  it("未知错误码原样带出，不吞掉", () => {
    expect(jobError("something_new")).toBe("生成失败（something_new）");
    expect(jobError(null)).toBe("");
  });
});
