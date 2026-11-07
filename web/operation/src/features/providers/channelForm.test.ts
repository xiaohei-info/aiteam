import { describe, expect, it } from "vitest";
import {
  capabilitiesToForm,
  channelToForm,
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
    const form = { ...emptyChannelForm(), name: "新渠道", models: "gpt-5.6" };
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
    expect(formToChannelInput({ ...base, models: " " }, { isNew: false })).toEqual({ ok: false, error: "至少填写一个模型" });
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
