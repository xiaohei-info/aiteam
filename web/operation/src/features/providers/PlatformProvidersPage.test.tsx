import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformProvidersPage } from "./PlatformProvidersPage";

const providerApi = vi.hoisted(() => ({
  list: vi.fn(),
  models: vi.fn(),
  syncPublicPrices: vi.fn(),
  publishPricedModels: vi.fn(),
  publishModel: vi.fn(),
  setRate: vi.fn(),
  channels: vi.fn(),
  channelTypes: vi.fn(),
  createChannel: vi.fn(),
  updateChannel: vi.fn(),
  deleteChannel: vi.fn(),
  setChannelEnabled: vi.fn(),
  testChannel: vi.fn(),
  upstreamModels: vi.fn(),
  updateModelCapabilities: vi.fn(),
}));

const PROVIDER = {
  provider_id: "p1", provider_code: "newapi", display_name: "LLM 网关",
  relay_base_url: "http://127.0.0.1:9300/v1", api_protocol: "openai-completions",
  status: "published", version: 1, updated_at: "2026-01-01T00:00:00Z",
};

const CHANNEL = {
  id: 3, name: "Anthropic 主渠道", channel_type: 14, channel_type_label: "Anthropic", status: "enabled",
  base_url: "https://up.example", models: ["claude-sonnet-5-5"], model_mapping: {}, header_override: {}, param_override: {},
  group: "default", priority: 0, weight: 0, test_model: null, response_time_ms: null, tested_at: null,
};

const MODEL = {
  provider_id: "p1", model_id: "minimax-m3", display_name: "MiniMax M3", capabilities: {}, status: "published",
  source: "discovery", version: 1, updated_at: "2026-01-01T00:00:00Z",
};

vi.mock("./usePlatformProvidersApi", () => ({
  usePlatformProvidersApi: () => providerApi,
}));

describe("PlatformProvidersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerApi.list.mockReturnValue(new Promise(() => {}));
    providerApi.models.mockResolvedValue([]);
    providerApi.channels.mockResolvedValue([]);
    providerApi.channelTypes.mockResolvedValue([{ channel_type: 1, label: "OpenAI 兼容" }, { channel_type: 14, label: "Anthropic" }]);
  });

  it("只展示 LLM 网关，不提供新增服务入口", () => {
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: "新增大模型服务" })).not.toBeInTheDocument();
    expect(screen.getByText(/统一通过 LLM 网关/)).toBeInTheDocument();
    expect(screen.queryByText(/NewAPI/i)).not.toBeInTheDocument();
  });

  it("连接 LLM 网关后直接展示可用模型区域", async () => {
    providerApi.list.mockResolvedValue([{
      provider_id: "p1", provider_code: "newapi", display_name: "LLM 网关",
      relay_base_url: "http://127.0.0.1:9300/v1", api_protocol: "openai-completions",
      status: "published", version: 1, updated_at: "2026-01-01T00:00:00Z",
    }]);
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("LLM 网关暂无可用模型")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "发布全部有价格模型" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "价格" }));
    expect(screen.getByText(/新模型会自动补齐公开价格并发布/)).toBeInTheDocument();
  });

  it("有价草稿模型提供价格维护和发布入口", async () => {
    providerApi.list.mockResolvedValue([{
      provider_id: "p1", provider_code: "newapi", display_name: "LLM 网关",
      relay_base_url: "http://127.0.0.1:9300/v1", api_protocol: "openai-completions",
      status: "published", version: 1, updated_at: "2026-01-01T00:00:00Z",
    }]);
    providerApi.models.mockResolvedValue([
      {
        model: { provider_id: "p1", model_id: "minimax-m3", display_name: "MiniMax M3", capabilities: {}, status: "published", source: "discovery", version: 1, updated_at: "2026-01-01T00:00:00Z" },
        rate: { rate_id: "r1", provider_id: "p1", model_id: "minimax-m3", pricing_version: 1, pricing_status: "known", billing_mode: "token", input_usd_per_million: "0.3", output_usd_per_million: "1.2", cache_read_usd_per_million: null, cache_write_usd_per_million: null, request_usd: null, currency: "USD", source: "public_reference", effective_from: "2026-01-01T00:00:00Z" },
      },
      { model: { provider_id: "p1", model_id: "priced-draft", display_name: "", capabilities: {}, status: "draft", source: "discovery", version: 1, updated_at: "2026-01-01T00:00:00Z" }, rate: { rate_id: "r2", provider_id: "p1", model_id: "priced-draft", pricing_version: 1, pricing_status: "known", billing_mode: "token", input_usd_per_million: "0", output_usd_per_million: "0", cache_read_usd_per_million: null, cache_write_usd_per_million: null, request_usd: null, currency: "USD", source: "manual", effective_from: "2026-01-01T00:00:00Z" } },
    ]);
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("MiniMax M3")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "配置模型" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "价格" }));
    expect(screen.getAllByRole("button", { name: "设置价格" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "发布模型" })).toBeInTheDocument();
  });

  it("模型配置 tab 列出上游渠道，不显示 Key，可测试连接和删除", async () => {
    providerApi.list.mockResolvedValue([PROVIDER]);
    providerApi.channels.mockResolvedValue([CHANNEL]);
    providerApi.testChannel.mockResolvedValue({ ok: false, seconds: 1, message: "403 permission_error" });
    providerApi.deleteChannel.mockResolvedValue(null);
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("Anthropic 主渠道")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "模型配置" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText(/NewAPI/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(screen.getByText("连接失败：403 permission_error")).toBeInTheDocument());
    expect(providerApi.testChannel).toHaveBeenCalledWith("p1", 3);

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(providerApi.deleteChannel).toHaveBeenCalledWith("p1", 3));
  });

  it("新建渠道分三步：获取上游模型 → 勾选并改平台名 → 设置参数", async () => {
    providerApi.list.mockResolvedValue([PROVIDER]);
    providerApi.channels.mockResolvedValue([CHANNEL]);
    providerApi.upstreamModels.mockResolvedValue(["MiniMax-M3", "gpt-5.6", "embed-1"]);
    providerApi.createChannel.mockImplementation(async () => {
      providerApi.models.mockResolvedValue([{ model: { ...MODEL, model_id: "minimax-m3" }, rate: null }]);
      return CHANNEL;
    });
    providerApi.updateModelCapabilities.mockResolvedValue(MODEL);
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("Anthropic 主渠道")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "新增渠道" }));
    fireEvent.click(await screen.findByRole("button", { name: "获取模型并继续" }));
    expect(await screen.findByText("请填写渠道名称")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/渠道名称/), { target: { value: "新渠道" } });
    fireEvent.click(screen.getByRole("button", { name: "获取模型并继续" }));
    expect(await screen.findByText("新建渠道需要填写 API Key")).toBeInTheDocument();
    expect(providerApi.upstreamModels).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: "sk-up" } });
    fireEvent.change(screen.getByLabelText(/上游地址/), { target: { value: " https://up.example " } });
    fireEvent.click(screen.getByRole("button", { name: "获取模型并继续" }));

    expect(await screen.findByText("已选 0 / 共 3 个")).toBeInTheDocument();
    expect(providerApi.upstreamModels).toHaveBeenCalledWith("p1", { channel_type: 1, base_url: "https://up.example", key: "sk-up" });
    fireEvent.click(screen.getByRole("button", { name: "保存并继续" }));
    expect(await screen.findByText("至少选择一个模型")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索模型"), { target: { value: "m" } });
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect(screen.getByText("已选 2 / 共 3 个")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("embed-1"));
    expect(screen.getByText("已选 1 / 共 3 个")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全不选" }));
    expect(screen.getByText("已选 0 / 共 3 个")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索模型"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("MiniMax-M3"));
    fireEvent.change(screen.getByLabelText("MiniMax-M3 平台模型名"), { target: { value: "minimax-m3" } });
    fireEvent.change(screen.getByLabelText(/手动添加模型/), { target: { value: "extra-model" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(screen.getByText("已选 2 / 共 4 个")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("extra-model"));
    fireEvent.click(screen.getByRole("button", { name: "保存并继续" }));

    await waitFor(() => expect(providerApi.createChannel).toHaveBeenCalledWith("p1", expect.objectContaining({
      name: "新渠道", key: "sk-up", models: ["minimax-m3"], model_mapping: { "minimax-m3": "MiniMax-M3" },
    })));
    const row = await screen.findByRole("button", { name: /minimax-m3 · 上下文/ });
    expect(screen.getByRole("button", { name: "完成" })).toBeInTheDocument();
    fireEvent.click(row);
    fireEvent.change(await screen.findByLabelText(/^最大输出/), { target: { value: "300000" } });
    fireEvent.change(screen.getByLabelText(/^上下文窗口/), { target: { value: "200000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
    expect(await screen.findByText("minimax-m3：最大输出不能超过上下文窗口")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^最大输出/), { target: { value: "16000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
    await waitFor(() => expect(providerApi.updateModelCapabilities).toHaveBeenCalledWith("p1", "minimax-m3", expect.objectContaining({
      context_window: 200000, max_tokens: 16000,
    })));
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存参数" })).not.toBeInTheDocument());
  });

  it("编辑渠道：Key 留空用已保存渠道拉列表、不提交 key，取消勾选即移除模型", async () => {
    providerApi.list.mockResolvedValue([PROVIDER]);
    providerApi.channels.mockResolvedValue([{ ...CHANNEL, models: ["claude-sonnet-5-5", "old-model"] }]);
    providerApi.upstreamModels.mockResolvedValue(["claude-sonnet-5-5", "claude-haiku-5-5"]);
    providerApi.updateChannel.mockResolvedValue(CHANNEL);
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("Anthropic 主渠道")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(await screen.findByText("已保存渠道不能修改类型")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "获取模型并继续" }));
    expect(await screen.findByText("已选 2 / 共 3 个")).toBeInTheDocument();
    expect(providerApi.upstreamModels).toHaveBeenCalledWith("p1", { channel_id: 3 });
    fireEvent.click(screen.getByLabelText("old-model"));
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: "sk-new" } });
    providerApi.upstreamModels.mockRejectedValueOnce(new Error("LLM 网关操作失败：401"));
    fireEvent.click(screen.getByRole("button", { name: "获取模型并继续" }));
    expect(await screen.findByText("LLM 网关操作失败：401")).toBeInTheDocument();
    expect(providerApi.upstreamModels).toHaveBeenLastCalledWith("p1", { channel_type: 14, base_url: "https://up.example", key: "sk-new", channel_id: 3 });
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(await screen.findByRole("button", { name: "保存并继续" }));

    await waitFor(() => expect(providerApi.updateChannel).toHaveBeenCalledWith(
      "p1", 3, expect.not.objectContaining({ key: expect.anything() }),
    ));
    expect(providerApi.updateChannel.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ models: ["claude-sonnet-5-5"] }));
    expect(await screen.findByText(/claude-sonnet-5-5：模型同步中/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(screen.queryByText(/模型同步中/)).not.toBeInTheDocument());
  });

  it("上游没返回模型或保存失败时留在弹窗内提示，可手动添加", async () => {
    providerApi.list.mockResolvedValue([PROVIDER]);
    providerApi.channels.mockResolvedValue([CHANNEL]);
    providerApi.upstreamModels.mockResolvedValue([]);
    providerApi.createChannel.mockRejectedValue(new Error("渠道名称已存在"));
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("Anthropic 主渠道")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "新增渠道" }));
    fireEvent.change(await screen.findByLabelText(/渠道名称/), { target: { value: "新渠道" } });
    fireEvent.click(screen.getByRole("button", { name: "跳过获取，手动添加" }));
    expect(await screen.findByText("新建渠道需要填写 API Key")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: "sk" } });
    fireEvent.click(screen.getByRole("button", { name: "获取模型并继续" }));
    expect(await screen.findByText(/上游没有返回模型/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "跳过获取，手动添加" }));
    expect(await screen.findByText(/还没有模型/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/手动添加模型/), { target: { value: "gpt-5.6" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并继续" }));
    expect(await screen.findByText("渠道名称已存在")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存并继续" })).toBeInTheDocument();
  });

  it("模型配置弹窗可保存，失败时显示原因", async () => {
    providerApi.list.mockResolvedValue([PROVIDER]);
    providerApi.channels.mockResolvedValue([CHANNEL]);
    providerApi.models.mockResolvedValue([{ model: MODEL, rate: null }]);
    providerApi.updateModelCapabilities.mockRejectedValueOnce(new Error("网关不可用")).mockResolvedValueOnce(MODEL);
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "配置模型" }));
    fireEvent.change(await screen.findByLabelText(/^最大输出/), { target: { value: "300000" } });
    fireEvent.change(screen.getByLabelText(/^上下文窗口/), { target: { value: "200000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("最大输出不能超过上下文窗口")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^最大输出/), { target: { value: "16000" } });
    fireEvent.click(screen.getByLabelText("支持图片输入"));
    fireEvent.click(screen.getByRole("switch", { name: "支持思考" }));
    fireEvent.click(screen.getByLabelText("high（高）"));
    fireEvent.change(screen.getByLabelText("minimax-m3 high 上游取值"), { target: { value: "max" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("网关不可用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(providerApi.updateModelCapabilities).toHaveBeenLastCalledWith("p1", "minimax-m3", expect.objectContaining({
      context_window: 200000, max_tokens: 16000, reasoning: true, thinking_mode: "effort", thinking_level_map: { high: "max" }, input: ["text", "image"],
    })));
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存配置" })).not.toBeInTheDocument());
  });

  it("模型能力的 token 数可填任意正整数（如 200000、16000），不被浏览器步长校验拦下", async () => {
    providerApi.list.mockResolvedValue([PROVIDER]);
    providerApi.channels.mockResolvedValue([CHANNEL]);
    providerApi.models.mockResolvedValue([
      { model: { provider_id: "p1", model_id: "minimax-m3", display_name: "MiniMax M3", capabilities: {}, status: "published", source: "discovery", version: 1, updated_at: "2026-01-01T00:00:00Z" }, rate: null },
    ]);
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "配置模型" }));
    const context = await screen.findByLabelText(/^上下文窗口/) as HTMLInputElement;
    const maxTokens = screen.getByLabelText(/^最大输出/) as HTMLInputElement;
    fireEvent.change(context, { target: { value: "200000" } });
    fireEvent.change(maxTokens, { target: { value: "16000" } });
    expect(context.validity.valid).toBe(true);
    expect(maxTokens.validity.valid).toBe(true);
  });

  it("在大模型服务页提供 LLM 网关超链接，并保留价格更新入口", async () => {
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "打开 LLM 网关" })).toHaveAttribute("href", "http://localhost:9300/");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "大模型服务" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "打开 LLM 网关" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "打开 LLM 网关" })).toHaveAttribute("title", expect.stringContaining("管理凭据"));
  });
});
