import { describe, it, expect } from "vitest";
import { cn } from "./cn.js";

describe("cn", () => {
  it("合并并去重冲突的 tailwind 类（后者胜）", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
  });
  it("忽略假值", () => {
    expect(cn("a", false, undefined, "b")).toBe("a b");
  });
});
