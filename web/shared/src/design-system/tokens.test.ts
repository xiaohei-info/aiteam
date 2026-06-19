import { describe, it, expect } from "vitest";
import { tokens, tokensToCssVars, colorTokens } from "./tokens.js";

describe("design-system tokens", () => {
  it("exposes grouped tokens", () => {
    expect(tokens.color.brandPrimary).toBe(colorTokens.brandPrimary);
    expect(tokens.space.md).toBe("16px");
  });

  it("renders CSS custom properties with kebab names", () => {
    const vars = tokensToCssVars();
    expect(vars["--ai-color-brand-primary"]).toBe("#2563eb");
    expect(vars["--ai-space-md"]).toBe("16px");
    expect(vars["--ai-radius-pill"]).toBe("999px");
    expect(vars["--ai-z-modal"]).toBe("1300");
  });
});
