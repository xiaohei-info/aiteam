import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { PlatformProvidersPage } from "./PlatformProvidersPage";

vi.mock("./usePlatformProvidersApi", () => ({
  usePlatformProvidersApi: () => ({
    list: vi.fn().mockResolvedValue([]),
    models: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    sync: vi.fn(),
    syncPublicPrices: vi.fn(),
    publishPricedModels: vi.fn(),
    publishProvider: vi.fn(),
    publishModel: vi.fn(),
    setRate: vi.fn(),
  }),
}));

describe("PlatformProvidersPage", () => {
  it("在大模型服务页提供 NewAPI 网关超链接", () => {
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "打开大模型网关" })).toHaveAttribute("href", "/gateway");
  });
});
