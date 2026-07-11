import { describe, expect, it } from "vitest";
import { aiteamStone } from "./aiteam-stone.js";

describe("aiteamStone", () => {
  it("extends Stone with the approved blue accent and system Chinese typography", () => {
    expect(aiteamStone.name).toBe("aiteam-stone");
    expect(aiteamStone.__inputTokens?.["--color-accent"]).toEqual([
      "#3f5f88",
      "#9fc3ef",
    ]);
    expect(aiteamStone.tokens["--font-family-body"]).toContain("PingFang SC");
  });

  it("uses a crisp motion scale", () => {
    expect(aiteamStone.tokens["--duration-fast"]).toBe("125ms");
    expect(aiteamStone.tokens["--duration-medium"]).toBe("250ms");
  });
});
