import { describe, expect, it, vi } from "vitest";

import { getRunProvenance } from "./useRunsApi";

describe("getRunProvenance", () => {
  it("hits the run provenance endpoint with url-encoded id", async () => {
    const get = vi.fn(() => Promise.resolve({ meta: {}, binding: {}, capability: {} }));
    await getRunProvenance({ get } as never, "run abc");
    expect(get).toHaveBeenCalledWith("/api/agent/runs/run%20abc/provenance");
  });
});
