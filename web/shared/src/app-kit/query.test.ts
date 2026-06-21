import { describe, it, expect } from "vitest";
import { createQueryClient } from "./query.js";

describe("createQueryClient", () => {
  it("默认不在窗口聚焦时重抓、查询重试 1 次（统一服务端状态策略）", () => {
    const qc = createQueryClient();
    const def = qc.getDefaultOptions();
    expect(def.queries?.refetchOnWindowFocus).toBe(false);
    expect(def.queries?.retry).toBe(1);
  });
});
