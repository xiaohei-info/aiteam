import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GlassPanel, Button } from "@aiteam/shared/ui";

describe("shared 地基在 agent 端集成", () => {
  it("GlassPanel 与 Button 可被消费端 import 并渲染", () => {
    render(
      <GlassPanel data-testid="panel">
        <Button>发送</Button>
      </GlassPanel>,
    );
    expect(screen.getByTestId("panel").className).toContain("glass");
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });
});
