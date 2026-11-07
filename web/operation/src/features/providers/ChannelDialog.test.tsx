import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChannelDialog } from "./ChannelDialog";
import type { GatewayChannel, PlatformModel } from "./types";

const CHANNEL: GatewayChannel = {
  id: 3, name: "Anthropic 主渠道", channel_type: 14, channel_type_label: "Anthropic", status: "enabled",
  base_url: "https://up.example", models: ["claude-sonnet-5-5", "old-model"], model_mapping: {}, header_override: {}, param_override: {},
  group: "default", priority: 0, weight: 0, test_model: null, response_time_ms: null, tested_at: null,
};

const MODEL: PlatformModel = {
  provider_id: "p1", model_id: "claude-sonnet-5-5", display_name: "", capabilities: {}, status: "published",
  source: "discovery", version: 1, updated_at: "2026-01-01T00:00:00Z",
};

type Props = ComponentProps<typeof ChannelDialog>;

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    channel: null,
    types: [{ channel_type: 1, label: "OpenAI 兼容" }],
    models: [],
    busy: false,
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    onFetchModels: vi.fn().mockResolvedValue(["MiniMax-M3", "gpt-5.6", "embed-1"]),
    onSaveCapabilitiesBatch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<ChannelDialog {...props} />);
  return props;
}

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** New channel: fill step 1 and fetch the upstream list into step 2. */
async function newChannelAtModels(props: Partial<Props> = {}) {
  const result = setup(props);
  type(/渠道名称/, "新渠道");
  type(/API Key/, "sk-up");
  click("获取模型并继续");
  await screen.findByText(/^已选 /);
  return result;
}

/** Edited channel: skip fetching and save the existing models to reach step 3. */
async function editedChannelAtParams(props: Partial<Props> = {}) {
  const result = setup({ channel: { ...CHANNEL, models: ["claude-sonnet-5-5"] }, models: [MODEL], ...props });
  click("下一步");
  click("保存并继续");
  await screen.findByText(/渠道已保存/);
  return result;
}

describe("ChannelDialog 第①步 连接上游", () => {
  it("先校验渠道名称和新建时的 Key，再带上游地址拉取模型", async () => {
    const props = setup();
    click("获取模型并继续");
    expect(await screen.findByText("请填写渠道名称")).toBeInTheDocument();
    type(/渠道名称/, "新渠道");
    click("跳过获取，手动添加");
    expect(await screen.findByText("新建渠道需要填写 API Key")).toBeInTheDocument();
    expect(props.onFetchModels).not.toHaveBeenCalled();

    type(/API Key/, "sk-up");
    type(/上游地址/, " https://up.example ");
    click("获取模型并继续");
    expect(await screen.findByText("已选 0 / 共 3 个")).toBeInTheDocument();
    expect(props.onFetchModels).toHaveBeenCalledWith({ channel_type: 1, base_url: "https://up.example", key: "sk-up" });
  });

  it("上游没返回模型或拉取失败时留在第①步并提示", async () => {
    const onFetchModels = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("LLM 网关操作失败：401"));
    setup({ onFetchModels });
    type(/渠道名称/, "新渠道");
    type(/API Key/, "sk");
    click("获取模型并继续");
    expect(await screen.findByText(/上游没有返回模型/)).toBeInTheDocument();
    click("获取模型并继续");
    expect(await screen.findByText("LLM 网关操作失败：401")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "获取模型并继续" })).toBeInTheDocument();
  });

  it("编辑时 Key 留空用已保存渠道拉列表，填了新 Key 则带上新 Key", async () => {
    const props = setup({ channel: CHANNEL, onFetchModels: vi.fn().mockResolvedValue(["claude-sonnet-5-5", "claude-haiku-5-5"]) });
    expect(screen.getByText("已保存渠道不能修改类型")).toBeInTheDocument();
    click("获取模型并继续");
    expect(await screen.findByText("已选 2 / 共 3 个")).toBeInTheDocument();
    expect(props.onFetchModels).toHaveBeenCalledWith({ channel_id: 3 });

    click("上一步");
    type(/API Key/, "sk-new");
    click("获取模型并继续");
    await waitFor(() => expect(props.onFetchModels).toHaveBeenLastCalledWith({ channel_type: 14, base_url: "https://up.example", key: "sk-new", channel_id: 3 }));
  });
});

describe("ChannelDialog 第②步 选择模型", () => {
  it("高级设置默认收起，点击后展开", async () => {
    await newChannelAtModels();
    const advanced = screen.getByRole("button", { name: "高级设置" });
    expect(advanced).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(advanced);
    expect(advanced).toHaveAttribute("aria-expanded", "true");
  });

  it("搜索后全选/全不选只作用于可见模型", async () => {
    await newChannelAtModels();
    type("搜索模型", "m");
    click("全选");
    expect(screen.getByText("已选 2 / 共 3 个")).toBeInTheDocument();
    click("全不选");
    expect(screen.getByText("已选 0 / 共 3 个")).toBeInTheDocument();
  });

  it("勾选、改平台名、手动添加后保存，生成 models 与 model_mapping", async () => {
    const props = await newChannelAtModels();
    click("保存并继续");
    expect(await screen.findByText("至少选择一个模型")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("MiniMax-M3"));
    type("MiniMax-M3 平台模型名", "minimax-m3");
    type(/手动添加模型/, "extra-model");
    click("添加");
    expect(screen.getByText("已选 2 / 共 4 个")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("extra-model"));
    click("保存并继续");

    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({
      name: "新渠道", key: "sk-up", models: ["minimax-m3"], model_mapping: { "minimax-m3": "MiniMax-M3" },
    })));
    expect(await screen.findByText(/minimax-m3：模型同步中/)).toBeInTheDocument();
  });

  it("新建时可跳过获取直接手动添加；保存失败留在第②步显示原因", async () => {
    setup({ onSave: vi.fn().mockRejectedValue(new Error("渠道名称已存在")) });
    type(/渠道名称/, "新渠道");
    type(/API Key/, "sk");
    click("跳过获取，手动添加");
    expect(await screen.findByText(/还没有模型/)).toBeInTheDocument();
    type(/手动添加模型/, "gpt-5.6");
    click("添加");
    click("保存并继续");
    expect(await screen.findByText("渠道名称已存在")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存并继续" })).toBeInTheDocument();
  });

  it("编辑时取消勾选即从渠道移除，且不提交 key", async () => {
    const props = setup({ channel: CHANNEL });
    click("下一步");
    fireEvent.click(await screen.findByLabelText("old-model"));
    click("保存并继续");
    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1));
    const input = vi.mocked(props.onSave).mock.calls[0]?.[0];
    expect(input?.models).toEqual(["claude-sonnet-5-5"]);
    expect(input && "key" in input).toBe(false);
  });
});

describe("ChannelDialog 第③步 模型参数", () => {
  it("没改参数时直接完成", async () => {
    const props = await editedChannelAtParams();
    expect(screen.getByRole("button", { name: /claude-sonnet-5-5 · 上下文/ })).toHaveAttribute("aria-expanded", "false");
    click("完成");
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onSaveCapabilitiesBatch).not.toHaveBeenCalled();
  });

  it("只保存改动过的模型，校验失败时留在弹窗", async () => {
    const props = await editedChannelAtParams();
    click(/claude-sonnet-5-5 · 上下文/);
    type(/^最大输出/, "300000");
    type(/^上下文窗口/, "200000");
    click("保存参数");
    expect(await screen.findByText("claude-sonnet-5-5：最大输出不能超过上下文窗口")).toBeInTheDocument();
    expect(props.onSaveCapabilitiesBatch).not.toHaveBeenCalled();

    type(/^最大输出/, "16000");
    click("保存参数");
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(props.onSaveCapabilitiesBatch).toHaveBeenCalledWith([
      ["claude-sonnet-5-5", expect.objectContaining({ context_window: 200000, max_tokens: 16000 })],
    ]);
  });

  it("保存参数失败时显示原因、不关闭", async () => {
    const props = await editedChannelAtParams({ onSaveCapabilitiesBatch: vi.fn().mockRejectedValue(new Error("网关不可用")) });
    click(/claude-sonnet-5-5 · 上下文/);
    type(/^上下文窗口/, "200000");
    click("保存参数");
    expect(await screen.findByText("网关不可用")).toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
