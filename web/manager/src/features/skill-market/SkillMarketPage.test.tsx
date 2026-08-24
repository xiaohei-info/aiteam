import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SkillMarketPage } from "./SkillMarketPage";

const api = { list: vi.fn(), install: vi.fn() };
vi.mock("./useSkillMarketApi", () => ({ useSkillMarketApi: () => api }));

beforeEach(() => {
  vi.clearAllMocks();
  api.list.mockResolvedValue([{ skill_id: "s1", owner: "pub", slug: "demo", display_name: "Demo", summary: "x", published_version: "1.0.0", content_hash: "hash", status: "published", installed: false, update_available: false }]);
  api.install.mockResolvedValue({});
});

describe("SkillMarketPage", () => {
  it("从 Operator 平台市场安装到企业技能库", async () => {
    render(<SkillMarketPage />);
    await screen.findByText("Demo");
    fireEvent.click(screen.getByRole("button", { name: "安装" }));
    await waitFor(() => expect(api.install).toHaveBeenCalledWith(expect.objectContaining({ skill_id: "s1", published_version: "1.0.0" })));
  });
});
