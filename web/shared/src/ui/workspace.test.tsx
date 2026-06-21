import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Workspace } from "./workspace.js";

describe("Workspace", () => {
  it("渲染主区；有 panel 时渲染右面板与标题", () => {
    render(
      <Workspace panelTitle={<span>执行时间线</span>} panel={<div>步骤</div>}>
        <div>对话</div>
      </Workspace>,
    );
    expect(screen.getByText("对话")).toBeInTheDocument();
    expect(screen.getByText("执行时间线")).toBeInTheDocument();
    expect(screen.getByText("步骤")).toBeInTheDocument();
  });

  it("无 panel 时不渲染右面板区域", () => {
    render(<Workspace><div>仅对话</div></Workspace>);
    expect(screen.getByText("仅对话")).toBeInTheDocument();
    expect(screen.queryByTestId("ws-panel")).toBeNull();
  });
});
