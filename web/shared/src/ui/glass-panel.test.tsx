import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GlassPanel } from "./glass-panel.js";

describe("GlassPanel", () => {
  it("渲染子节点且带 glass 基类（降级由 CSS @supports 承担）", () => {
    render(<GlassPanel data-testid="p">内容</GlassPanel>);
    const el = screen.getByTestId("p");
    expect(el).toHaveTextContent("内容");
    expect(el.className).toContain("glass");
  });

  it("合并外部 className 且可透传属性", () => {
    render(<GlassPanel data-testid="p" className="p-md" role="region" />);
    const el = screen.getByTestId("p");
    expect(el.className).toContain("p-md");
    expect(el).toHaveAttribute("role", "region");
  });
});
