import { describe, expect, it } from "vitest";
import { cardMetrics, cardTagline, formatPricing, rateTone, resolutionRateText } from "../profile";

const base = { template_id: "tpl-1", version: "1", display_name: "专家" };

describe("人才市场展示规则", () => {
  it("一句话定位缺失时取岗位描述前 40 字", () => {
    expect(cardTagline({ ...base, tagline: "售后一站解决", description: "长描述" })).toBe("售后一站解决");
    expect(cardTagline({ ...base, description: "字".repeat(45) })).toBe(`${"字".repeat(40)}…`);
    expect(cardTagline({ ...base, description: "短描述" })).toBe("短描述");
  });

  it("卡片指标按优先级最多 3 项，没有数据的不显示", () => {
    const metrics = cardMetrics({
      ...base,
      stats: { resolution_rate: 0.85, evaluated_segments: 40, resolved_segments: 34, min_sample: 10 },
      pricing: { mode: "per_call", unit_price: "0.050000", currency: "USD" },
      platform_skill_refs: [{ skill_id: "s1", version: "1", content_hash: "h" }],
      platform_model_ref: { provider_id: "p", provider_version: 1, model_id: "gpt-5", model_version: 1 },
    });
    expect(metrics).toEqual([
      { label: "解决率", value: "85%", tone: "success" },
      { label: "计价", value: "$0.05/次" },
      { label: "技能", value: "1 项" },
    ]);
    expect(cardMetrics(base)).toEqual([]);
  });

  it("样本不足时卡片不显示解决率，详情显示样本不足而不是 0%", () => {
    const stats = { resolution_rate: null, evaluated_segments: 3, resolved_segments: 0, min_sample: 10 };
    expect(cardMetrics({ ...base, stats }).map((metric) => metric.label)).not.toContain("解决率");
    expect(resolutionRateText(stats)).toBe("样本不足（已评估 3 段，满 10 段后显示）");
    expect(resolutionRateText(stats)).not.toContain("0%");
  });

  it("解决率分档与计价格式", () => {
    expect([rateTone(0.8), rateTone(0.6), rateTone(0.59)]).toEqual(["success", "primary", "warning"]);
    expect(formatPricing({ mode: "per_token", unit_price: 2, currency: "USD" })).toBe("$2/百万 Token");
    expect(formatPricing({ mode: "subscription", unit_price: "99", currency: "USD" })).toBe("$99 套餐");
  });
});
