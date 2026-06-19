import { describe, it, expect, vi } from "vitest";
import { createI18n, I18n, sharedMessages, DEFAULT_LOCALE } from "./index.js";

describe("i18n", () => {
  it("defaults to zh-CN", () => {
    const i18n = createI18n({ catalog: sharedMessages });
    expect(i18n.currentLocale).toBe(DEFAULT_LOCALE);
    expect(i18n.t("common.loading")).toBe("加载中…");
  });

  it("interpolates params", () => {
    const i18n = createI18n({
      catalog: { "zh-CN": { greet: "你好 {name}，共 {count} 项" } },
    });
    expect(i18n.t("greet", { name: "小黑", count: 3 })).toBe("你好 小黑，共 3 项");
  });

  it("keeps placeholder when param missing", () => {
    const i18n = createI18n({ catalog: { "zh-CN": { greet: "Hi {name}" } } });
    expect(i18n.t("greet")).toBe("Hi {name}");
  });

  it("falls back to fallbackLocale then key", () => {
    const i18n = new I18n({
      locale: "en-US",
      fallbackLocale: "zh-CN",
      catalog: { "zh-CN": { only_zh: "中文" } },
    });
    expect(i18n.t("only_zh")).toBe("中文");
    expect(i18n.t("missing.key")).toBe("missing.key");
  });

  it("setLocale notifies and switches", () => {
    const i18n = createI18n({
      catalog: { "zh-CN": { k: "中" }, "en-US": { k: "en" } },
    });
    const listener = vi.fn();
    i18n.onChange(listener);
    i18n.setLocale("en-US");
    expect(i18n.t("k")).toBe("en");
    expect(listener).toHaveBeenCalledWith("en-US");
  });

  it("extend merges messages", () => {
    const i18n = createI18n({ catalog: { "zh-CN": {} } });
    i18n.extend("zh-CN", { custom: "自定义" });
    expect(i18n.t("custom")).toBe("自定义");
  });
});
