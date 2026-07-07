import { describe, expect, it, vi } from "vitest";

import { getExpertReadiness, getReadinessReport } from "./useExpertReadinessApi";

describe("readiness api client", () => {
  it("getReadinessReport hits the report endpoint", async () => {
    const get = vi.fn(() => Promise.resolve({ runtime: "ready", experts: [] }));
    await getReadinessReport({ get } as never);
    expect(get).toHaveBeenCalledWith("/api/agent/grants/readiness");
  });

  it("getExpertReadiness hits the expert endpoint with url-encoded id", async () => {
    const get = vi.fn(() => Promise.resolve({ employee_id: "emp x", available: true }));
    await getExpertReadiness({ get } as never, "emp x");
    expect(get).toHaveBeenCalledWith("/api/agent/grants/experts/emp%20x/readiness");
  });
});
