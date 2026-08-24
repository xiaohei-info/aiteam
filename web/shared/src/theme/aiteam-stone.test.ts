import { describe, expect, it } from "vitest";
import { aiteamStone } from "./aiteam-stone.js";

describe("aiteamStone", () => {
  it("extends Stone with the approved blue accent and system Chinese typography", () => {
    expect(aiteamStone.name).toBe("aiteam-stone");
    expect(aiteamStone.__inputTokens?.["--color-accent"]).toEqual([
      "#3f5f88",
      "#9fc3ef",
    ]);
    expect(aiteamStone.__inputTokens?.["--color-text-secondary"]).toEqual([
      "#5b6066",
      "#b8bec5",
    ]);
    for (const token of ["--color-on-success", "--color-on-error", "--color-on-warning"] as const) {
      expect(aiteamStone.__inputTokens?.[token]).toEqual(["#ffffff", "#17202b"]);
    }
    expect(aiteamStone.tokens["--font-family-body"]).toContain("PingFang SC");
  });

  it("uses a crisp motion scale", () => {
    expect(aiteamStone.tokens["--duration-fast"]).toBe("125ms");
    expect(aiteamStone.tokens["--duration-medium"]).toBe("250ms");
  });

  it("uses compact heading hierarchy and restrained surface elevation", () => {
    expect(aiteamStone.tokens["--text-heading-1-size"]).toBe("1.875rem");
    expect(aiteamStone.tokens["--text-heading-1-leading"]).toBe("1.2");
    expect(aiteamStone.components?.heading?.["level:1"]?.letterSpacing).toBe("-0.02em");
    expect(aiteamStone.components?.card?.base?.boxShadow).toBe("var(--shadow-low)");
    expect(aiteamStone.components?.["chat-composer"]?.base?.boxShadow).toBe("var(--shadow-med)");
  });
});
