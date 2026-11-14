import { describe, expect, it } from "vitest";

import { isSelectablePlatformModel } from "./platform-models.js";

describe("isSelectablePlatformModel", () => {
  it("只有已发布且价格已生效的模型可选", () => {
    expect(isSelectablePlatformModel({ model: { status: "published" }, rate: { pricing_status: "known" } })).toBe(true);
    expect(isSelectablePlatformModel({ model: { status: "published" }, rate: { pricing_status: "unknown" } })).toBe(false);
    expect(isSelectablePlatformModel({ model: { status: "published" }, rate: null })).toBe(false);
    expect(isSelectablePlatformModel({ model: { status: "published" } })).toBe(false);
    expect(isSelectablePlatformModel({ model: { status: "draft" }, rate: { pricing_status: "known" } })).toBe(false);
  });
});
