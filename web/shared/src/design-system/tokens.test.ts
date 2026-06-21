import { describe, it, expect } from "vitest";
import { tokens } from "./tokens.js";

describe("黑金 design tokens", () => {
  it("画布为暖黑、品牌为金", () => {
    expect(tokens.color.bgCanvas).toBe("#0c0a07");
    expect(tokens.color.gold).toBe("#cda349");
  });

  it("含玻璃材质参数（模糊度/实色降级背景）", () => {
    expect(tokens.glass.blurPanel).toBe("30px");
    expect(tokens.glass.bgSolid).toBe("#16120d");
  });

  it("半径含窗体大圆角", () => {
    expect(tokens.radius.window).toBe("16px");
  });
});
