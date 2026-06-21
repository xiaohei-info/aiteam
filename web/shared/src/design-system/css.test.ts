import { describe, it, expect } from "vitest";
import { buildTokensCss } from "./css.js";

describe("buildTokensCss", () => {
  const css = buildTokensCss();

  it("产出 Tailwind v4 @theme 块且含金色变量", () => {
    expect(css).toContain("@theme");
    expect(css).toContain("--color-gold: #cda349;");
    expect(css).toContain("--color-bg-canvas: #0c0a07;");
  });

  it("含玻璃基样 .glass 与 @supports 降级（不支持时退实色 #16120d）", () => {
    expect(css).toContain(".glass");
    // 锁住标准属性与 webkit 前缀双写契约（仅断言 "backdrop-filter" 会被 -webkit- 误命中）。
    expect(css).toContain("backdrop-filter: blur(30px) saturate(150%)");
    expect(css).toContain("-webkit-backdrop-filter: blur(30px) saturate(150%)");
    expect(css).toContain("@supports not (backdrop-filter: blur(1px))");
    expect(css).toContain("#16120d");
  });
});
