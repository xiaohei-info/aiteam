import { describe, expect, it, vi } from "vitest";
import type { AgentApiClient } from "../../lib/api-client";
import { listLoadedExperts, listSolutionInstances, createGroupConversation } from "./useGroupApi";
import { parseMentions } from "./MentionComposer";
import { footerHandles } from "../chat/MessageComposer";

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

  it("keeps delegation mentions on the Pi stable handle, not display_name", () => {
    const roster = [{ employee_id: "e1", tenant_id: "t1", version: "v1", handle: "alice", display_name: "Alice", revoked: false }];
    expect(footerHandles(roster)).toEqual(["alice"]);
    expect(parseMentions("请 @alice 处理", new Set(["alice"]))).toEqual(["alice"]);
    expect(parseMentions("请 @Alice 处理", new Set(["alice"]))).toEqual([]);
  });

  it("creates a server-owned group metadata record with coordinator authorization", async () => {
    const client = { post: vi.fn(async (_path: string, options: { body: unknown }) => ({
      id: "c1",
      title: "Group",
      kind: "group",
      state: "active",
      entry_employee_id: null,
      coordinator_employee_id: "e1",
      solution_instance_id: "s1",
      schedule: null,
      last_read_entry_id: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      options,
    })) } as unknown as AgentApiClient;
    await createGroupConversation(client, { title: "Group", solution_instance_id: "s1", coordinator_employee_id: "e1" });
    expect(client.post).toHaveBeenCalledWith("/api/agent/conversations", {
      body: expect.objectContaining({ kind: "group", coordinator_employee_id: "e1", solution_instance_id: "s1" }),
    });
    expect(localStorage.getItem("aiteam.agent.conversations")).toBeNull();
  });
});
