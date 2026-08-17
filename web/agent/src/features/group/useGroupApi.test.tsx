import { describe, expect, it, vi } from "vitest";
import type { AgentApiClient } from "../../lib/api-client";
import { listLoadedExperts, listSolutionInstances, createLocalGroupConversation } from "./useGroupApi";

describe("useGroupApi read-only projections", () => {
  it("reads the authorized roster projection", async () => {
    const data = [{ employee_id: "e1", tenant_id: "t1", version: "v1", handle: "expert", display_name: "Expert", revoked: false }];
    const client = { listGet: vi.fn(async () => ({ items: data, page: { next_cursor: null, has_more: false } })) } as unknown as AgentApiClient;
    await expect(listLoadedExperts(client)).resolves.toEqual(data);
    expect(client.listGet).toHaveBeenCalledWith("/api/agent/grants/experts");
  });

  it("reads authorized solutions without exposing planner fields", async () => {
    const data = [{ solution_instance_id: "s1", display_name: "Solution", version: "1" }];
    const client = { listGet: vi.fn(async () => ({ items: data, page: { next_cursor: null, has_more: false } })) } as unknown as AgentApiClient;
    await expect(listSolutionInstances(client)).resolves.toEqual(data);
    expect(client.listGet).toHaveBeenCalledWith("/api/agent/grants/solutions");
  });

  it("creates only a local group index", () => {
    localStorage.clear();
    const conversation = createLocalGroupConversation({ title: "Group", solution_instance_id: "s1" });
    expect(conversation.collaboration_mode).toBe("orchestrated");
    expect(JSON.parse(localStorage.getItem("aiteam.agent.conversations") ?? "[]")[0].solution_instance_id).toBe("s1");
  });
});
