import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./error-boundary.js";

function Boom(): never {
  throw new Error("炸了");
}

describe("ErrorBoundary", () => {
  it("子树抛错时渲染兜底 UI 而非崩整页", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary fallback={<div>出错了</div>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("出错了")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("正常时透传子节点", () => {
    render(
      <ErrorBoundary fallback={<div>出错了</div>}>
        <div>正常</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("正常")).toBeInTheDocument();
  });
});
