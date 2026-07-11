import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { RouterLinkAdapter } from "./RouterLinkAdapter";

describe("RouterLinkAdapter", () => {
  it("maps Astryx href to React Router to", () => {
    render(
      <MemoryRouter>
        <RouterLinkAdapter href="/audit">审计</RouterLinkAdapter>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "审计" })).toHaveAttribute(
      "href",
      "/audit",
    );
  });
});
