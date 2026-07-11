import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { RouterLinkAdapter } from "./RouterLinkAdapter";

describe("RouterLinkAdapter", () => {
  it("把 Astryx href 映射为 React Router 链接并转发焦点", () => {
    render(
      <MemoryRouter>
        <RouterLinkAdapter href="/board">治理看板</RouterLinkAdapter>
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: "治理看板" });
    expect(link).toHaveAttribute("href", "/board");
    link.focus();
    expect(link).toHaveFocus();
  });
});
