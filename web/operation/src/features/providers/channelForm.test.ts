import { describe, expect, it } from "vitest";
import {
  addModelRows,
  capabilitiesToForm,
  channelStatusLabel,
  channelToForm,
  connectionError,
  mergeModelRows,
  type ModelRow,
  emptyChannelForm,
  formatTokens,
  formToCapabilitiesInput,
  formToChannelInput,
  MASK,
  parseModelList,
} from "./channelForm";
import type { GatewayChannel, PlatformModel } from "./types";

const channel: GatewayChannel = {
  id: 7, name: "主渠道", channel_type: 14, channel_type_label: "Anthropic", status: "enabled",
  base_url: "https://up.example", models: ["a", "b"], model_mapping: { a: "a-2026" },
  header_override: { "X-Api-Key": MASK }, param_override: {}, group: "default", priority: 1, weight: 0,
  test_model: null, response_time_ms: null, tested_at: null,
};

describe("channel form", () => {
  it("把模型文本拆成去重列表", () => {
    expect(parseModelList(" a \nb, a\n\n c ")).toEqual(["a", "b", "c"]);
  });

  it("新建渠道必须填 Key，编辑时留空不提交 key", () => {
    const form = { ...emptyChannelForm(), name: "新渠道", rows: [{ upstream: "gpt-5.6", name: "gpt-5.6", selected: true }] };
    expect(formToChannelInput(form, { isNew: true })).toEqual({ ok: false, error: "新建渠道需要填写 API Key" });
    const edit = formToChannelInput(channelToForm(channel), { isNew: false });
    expect(edit.ok && "key" in edit.value).toBe(false);
    expect(edit.ok && edit.value.header_override).toEqual({ "X-Api-Key": MASK });
    expect(edit.ok && edit.value.model_mapping).toEqual({ a: "a-2026" });
  });

  it("拒绝无效 JSON 和非字符串的请求头值", () => {
    const base = { ...channelToForm(channel) };
    expect(formToChannelInput({ ...base, paramOverride: "{bad" }, { isNew: false })).toEqual({ ok: false, error: "参数覆盖不是有效的 JSON" });
    expect(formToChannelInput({ ...base, headerOverride: "[]" }, { isNew: false })).toEqual({ ok: false, error: "自定义请求头必须是 JSON 对象" });
    expect(formToChannelInput({ ...base, headerOverride: '{"X": 1}' }, { isNew: false })).toEqual({ ok: false, error: "自定义请求头的值必须是字符串" });
    expect(formToChannelInput({ ...base, rows: base.rows.map((row) => ({ ...row, selected: false })) }, { isNew: false })).toEqual({ ok: false, error: "至少选择一个模型" });
  });

  it("编辑时把模型映射还原成上游名/平台名，并保留不属于列表的映射", () => {
    const form = channelToForm({ ...channel, model_mapping: { a: "a-2026", orphan: "x" } });
    expect(form.rows).toEqual([
      { upstream: "a-2026", name: "a", selected: true },
      { upstream: "b", name: "b", selected: true },
    ]);
    expect(form.extraMapping).toEqual({ orphan: "x" });
    const result = formToChannelInput(form, { isNew: false });
    expect(result.ok && result.value.model_mapping).toEqual({ orphan: "x", a: "a-2026" });
  });

  it("由勾选的模型行生成 models 与 model_mapping，并校验平台名", () => {
    const base = { ...emptyChannelForm(), name: "新渠道", key: "sk" };
    const minimax: ModelRow = { upstream: "MiniMax-M3", name: "minimax-m3", selected: true };
    const gpt: ModelRow = { upstream: "gpt-5.6", name: "gpt-5.6", selected: true };
    const rows: ModelRow[] = [minimax, gpt, { upstream: "embed", name: "embed", selected: false }];
    const result = formToChannelInput({ ...base, rows }, { isNew: true });
    expect(result.ok && result.value.models).toEqual(["minimax-m3", "gpt-5.6"]);
    expect(result.ok && result.value.model_mapping).toEqual({ "minimax-m3": "MiniMax-M3" });
    expect(result.ok && result.value.key).toBe("sk");
    expect(formToChannelInput({ ...base, rows: [{ ...minimax, name: " " }] }, { isNew: true })).toEqual({ ok: false, error: "模型「MiniMax-M3」的平台模型名不能为空" });
    expect(formToChannelInput({ ...base, rows: [minimax, { ...gpt, name: "minimax-m3" }] }, { isNew: true })).toEqual({ ok: false, error: "平台模型名「minimax-m3」重复" });
    expect(formToChannelInput({ ...base, name: " ", rows }, { isNew: true })).toEqual({ ok: false, error: "请填写渠道名称" });
  });

  it("合并上游列表与手动添加的模型", () => {
    const rows: ModelRow[] = [{ upstream: "a", name: "a", selected: true }];
    expect(mergeModelRows(rows, ["a", "b", "b"])).toEqual([
      { upstream: "a", name: "a", selected: true },
      { upstream: "b", name: "b", selected: false },
    ]);
    expect(addModelRows(mergeModelRows(rows, ["b"]), "b, c")).toEqual([
      { upstream: "a", name: "a", selected: true },
      { upstream: "b", name: "b", selected: true },
      { upstream: "c", name: "c", selected: true },
    ]);
  });

  it("第一步校验渠道名称和新建时的 Key", () => {
    expect(connectionError(emptyChannelForm(), { isNew: true })).toBe("请填写渠道名称");
    expect(connectionError({ ...emptyChannelForm(), name: "x" }, { isNew: true })).toBe("新建渠道需要填写 API Key");
    expect(connectionError({ ...emptyChannelForm(), name: "x" }, { isNew: false })).toBeNull();
  });

  it("渠道状态文案", () => {
    expect(channelStatusLabel("enabled").label).toBe("已启用");
    expect(channelStatusLabel("manually_disabled").label).toBe("已停用");
    expect(channelStatusLabel("auto_disabled").label).toBe("自动停用");
    expect(channelStatusLabel("other" as GatewayChannel["status"]).label).toBe("未知状态");
  });
});

describe("capabilities form", () => {
  const model: PlatformModel = {
    provider_id: "p1", model_id: "claude", display_name: "Claude", status: "published", source: "discovery", version: 1, updated_at: "",
    capabilities: { reasoning: true, thinking_mode: "effort", thinking_levels: ["off", "high", "low"], thinking_level_map: { high: "max" }, context_window: 200000, input_modalities: ["text", "image"] },
  };

  it("从目录能力回填表单", () => {
    const form = capabilitiesToForm(model);
    expect(form.levels).toEqual(["off", "low", "high"]);
    expect(form.levelMap).toEqual({ high: "max" });
    expect(form.contextWindow).toBe(200000);
    expect(form.maxTokens).toBeNull();
    expect(form.image).toBe(true);
  });

  it("校验并生成提交体", () => {
    const form = capabilitiesToForm(model);
    const result = formToCapabilitiesInput({ ...form, maxTokens: 64000, levelMap: { high: " max ", low: "" } });
    expect(result).toEqual({ ok: true, value: {
      display_name: "Claude", context_window: 200000, max_tokens: 64000, reasoning: true, thinking_mode: "effort",
      thinking_levels: ["off", "low", "high"], thinking_level_map: { high: "max" }, input: ["text", "image"],
    } });
    expect(formToCapabilitiesInput({ ...form, maxTokens: 300000 })).toEqual({ ok: false, error: "最大输出不能超过上下文窗口" });
    expect(formToCapabilitiesInput({ ...form, levels: ["off"] })).toEqual({ ok: false, error: "支持思考的模型至少开放一个思考档位" });
    const plain = formToCapabilitiesInput({ ...form, reasoning: false });
    expect(plain.ok && plain.value.thinking_levels).toEqual(["off"]);
    expect(plain.ok && plain.value.thinking_mode).toBe("none");
  });

  it("格式化 token 数", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(200000)).toBe("200K");
    expect(formatTokens(undefined)).toBe("—");
  });
});
