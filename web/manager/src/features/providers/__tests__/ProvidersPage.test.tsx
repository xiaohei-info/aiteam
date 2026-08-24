import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProvidersPage } from "../ProvidersPage";
import { usePlatformModelsApi } from "../../platform-models/usePlatformModelsApi";

vi.mock("../../platform-models/usePlatformModelsApi", () => ({ usePlatformModelsApi: vi.fn() }));

const catalog = {
  providers: [{ provider_id: "p1", provider_code: "newapi", display_name: "内部 NewAPI", status: "published", version: 2 }],
  models: [{
    model: { provider_id: "p1", model_id: "minimax-m3", display_name: "MiniMax M3", status: "published", version: 3 },
    rate: { pricing_version: 4, pricing_status: "known", input_usd_per_million: "0.300000", output_usd_per_million: "1.200000", cache_read_usd_per_million: "0.060000", cache_write_usd_per_million: null, currency: "USD" },
  }],
};

describe("Manager platform model catalog", () => {
  beforeEach(() => vi.mocked(usePlatformModelsApi).mockReturnValue({ list: vi.fn().mockResolvedValue(catalog) }));

  it("shows only Operator-published read-only models and prices", async () => {
    render(<ProvidersPage />);
    expect(await screen.findByText("内部 NewAPI")).toBeInTheDocument();
    expect(screen.getByText("MiniMax M3")).toBeInTheDocument();
    expect(screen.getByText(/\$0.300000\/\$1.200000/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新增|编辑|删除/ })).not.toBeInTheDocument();
  });

  it("shows an explicit empty state", async () => {
    vi.mocked(usePlatformModelsApi).mockReturnValue({ list: vi.fn().mockResolvedValue({ providers: [], models: [] }) });
    render(<ProvidersPage />);
    expect(await screen.findByText("暂无可用平台模型")).toBeInTheDocument();
  });

  it("shows bounded load failure", async () => {
    vi.mocked(usePlatformModelsApi).mockReturnValue({ list: vi.fn().mockRejectedValue(new Error("Operator unavailable")) });
    render(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText("Operator unavailable")).toBeInTheDocument());
  });
});
