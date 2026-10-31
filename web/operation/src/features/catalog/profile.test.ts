import { describe, expect, it } from "vitest";
import { filledProfileFields, formatPricingSummary, profileFromItem, profilePayload, validateProfile } from "./profile";

describe("人才市场展示字段", () => {
  it("旧模板缺字段时补齐默认值", () => {
    expect(profileFromItem({})).toMatchObject({ tagline: "", use_cases: [], pricing: null, required_permissions: null });
  });

  it("提交前去掉空行与空白，未勾选的权限按未声明提交", () => {
    const payload = profilePayload({
      ...profileFromItem({}),
      tagline: "  客服专家  ",
      use_cases: ["处理售后", "", "  退款  "],
      sample_outputs: [{ title: "  ", output_type: "document", preview_url: "" }],
      required_permissions: { full_access: false, local_directories: false },
    });
    expect(payload.tagline).toBe("客服专家");
    expect(payload.use_cases).toEqual(["处理售后", "退款"]);
    expect(payload.sample_outputs).toEqual([]);
    expect(payload.required_permissions).toBeNull();
  });

  it("注册只带填写过的字段", () => {
    const fields = filledProfileFields(profilePayload({ ...profileFromItem({}), tagline: "定位", output_types: ["code"] }));
    expect(fields).toEqual({ tagline: "定位", output_types: ["code"] });
  });

  it("按服务端约束校验长度、条数、链接和单价", () => {
    const errors = validateProfile(profilePayload({
      ...profileFromItem({}),
      tagline: "字".repeat(41),
      use_cases: ["一", "二", "三", "四", "五", "六", "七"],
      limitations: ["x".repeat(101)],
      sample_outputs: [{ title: "示例", output_type: "document", preview_url: "javascript:alert(1)" }],
      pricing: { mode: "per_call", unit_price: "0.1234567", currency: "USD" },
      changelog_url: "ftp://example.com",
    }));
    expect(errors).toEqual({
      tagline: "一句话定位不超过 40 字",
      use_cases: "适用场景最多 6 条",
      limitations: "不适用场景每条不超过 100 字",
      sample_outputs: "示例产出预览链接需为 http/https 地址",
      pricing: "参考单价需为非负数字，最多 6 位小数",
      changelog_url: "更新说明链接需为 http/https 地址",
    });
  });

  it("合法字段通过校验；按码点计长", () => {
    expect(validateProfile(profilePayload({
      ...profileFromItem({}),
      tagline: "😀".repeat(40),
      pricing: { mode: "per_token", unit_price: "0.05", currency: "USD" },
      changelog_url: "https://example.com/changelog",
    }))).toEqual({});
  });

  it("套餐必须选周期；按次 / 按 Token 提交时不带周期", () => {
    const subscription = { mode: "subscription", unit_price: "99", currency: "USD" } as const;
    expect(validateProfile(profilePayload({ ...profileFromItem({}), pricing: subscription }))).toEqual({
      billing_period: "套餐需选择周期（按月或按年）",
    });
    const yearly = profilePayload({ ...profileFromItem({}), pricing: { ...subscription, billing_period: "year" } });
    expect(validateProfile(yearly)).toEqual({});
    expect(yearly.pricing).toEqual({ mode: "subscription", unit_price: "99", currency: "USD", billing_period: "year" });
    // 先选了套餐周期再改成按次：周期不随请求发出，服务端不会 422。
    const switched = profilePayload({ ...profileFromItem({}), pricing: { mode: "per_call", unit_price: " 0.05 ", currency: "USD", billing_period: "month" } });
    expect(switched.pricing).toEqual({ mode: "per_call", unit_price: "0.05", currency: "USD" });
  });

  it("计价摘要带单位", () => {
    expect(formatPricingSummary({ mode: "subscription", unit_price: "99", currency: "USD", billing_period: "month" })).toBe("套餐 · 99 USD/月");
    expect(formatPricingSummary({ mode: "per_token", unit_price: "0.3", currency: "USD" })).toBe("按 Token · 0.3 USD/百万 Token");
    expect(formatPricingSummary({ mode: "per_call", unit_price: "0.05", currency: "USD" })).toBe("按次 · 0.05 USD/次");
  });
});
