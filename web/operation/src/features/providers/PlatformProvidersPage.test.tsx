import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { PlatformProvidersPage } from "./PlatformProvidersPage";

vi.mock("./usePlatformProvidersApi", () => ({
  usePlatformProvidersApi: () => ({
    list: vi.fn().mockReturnValue(new Promise(() => {})),
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
  it("在大模型服务页提供 NewAPI 网关超链接", async () => {
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "打开大模型网关" })).toHaveAttribute("href", "http://localhost:9300/");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "大模型服务" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "打开大模型网关" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "打开大模型网关" })).toHaveAttribute("title", expect.stringContaining("管理 Token"));
  });
});
