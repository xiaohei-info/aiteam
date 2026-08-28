import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SkillMarketPage } from "./SkillMarketPage";

const api = {
  listInternal: vi.fn(), listExternal: vi.fn(), download: vi.fn(), publish: vi.fn(), unpublish: vi.fn(),
  getSettings: vi.fn(), setSettings: vi.fn(),
};

vi.mock("./useSkillMarketApi", () => ({ useSkillMarketApi: () => api }));

beforeEach(() => {
  vi.clearAllMocks();
  api.listInternal.mockResolvedValue([{ skill_id: "s1", owner: "pub", slug: "demo", display_name: "Demo", summary: "x", latest_internal_version: "1.0.0", published_version: "1.0.0", content_hash: "hash", status: "published" }]);
  api.listExternal.mockResolvedValue([{ owner: "pub", slug: "demo", display_name: "Demo", summary: "x", latest_version: "1.0.0", downloads: 3, canonical_url: "https://clawhub.ai/pub/skills/demo" }]);
  api.getSettings.mockResolvedValue({ auto_publish_downloads: true });
  api.setSettings.mockResolvedValue({ auto_publish_downloads: false });
});

describe("SkillMarketPage", () => {
  it("展示内部/ClawHub 双市场、默认自动开放和下架操作", async () => {
    render(<SkillMarketPage />);
    await screen.findByText("Demo");
    expect(screen.getByRole("button", { name: "内部技能市场" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ClawHub 外部市场" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /下载后自动开放/ })).toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: /下载后自动开放/ }));
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith(false));
    fireEvent.click(screen.getByRole("button", { name: "下架" }));
    await waitFor(() => expect(api.unpublish).toHaveBeenCalledWith("s1"));
  });
});
