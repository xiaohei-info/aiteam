import { describe, expect, it, vi } from "vitest";
import type { AgentApiClient } from "../../lib/api-client";
import { listConversationParticipants, listLoadedExperts, listSolutionInstances, createGroupConversation } from "./useGroupApi";
import { parseMentions } from "./mention";
import { footerHandles } from "../chat/MessageComposer";

describe("useGroupApi read-only projections", () => {
  it("reads the authorized roster projection", async () => {
    const data = [{ employee_id: "e1", tenant_id: "t1", version: "v1", handle: "expert", display_name: "Expert", revoked: false }];
    const client = { listGet: vi.fn(async () => ({ items: data, page: { next_cursor: null, has_more: false } })) } as unknown as AgentApiClient;
    await expect(listLoadedExperts(client)).resolves.toEqual(data);
    expect(client.listGet).toHaveBeenCalledWith("/api/agent/grants/experts");
  });

  it("reads the fixed owner-scoped participant roster without falling back to grants", async () => {
    const participants = [{ employee_id: "e1", display_name: "Coordinator", handle: "coord", role_title: null, department_ids: [], role: "coordinator" as const, available: false }];
    const client = { get: vi.fn(async () => ({ conversation_id: "c1", participants, employee_count: 1 })) } as unknown as AgentApiClient;
    await expect(listConversationParticipants(client, "c1")).resolves.toEqual(participants);
    expect(client.get).toHaveBeenCalledWith("/api/agent/conversations/c1/participants");
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

  it("resolves a manually typed display name to its stable handle", () => {
    expect(parseMentions("请 @测试员 处理", new Set(["tester"]), new Map([["测试员", "tester"]]))).toEqual(["tester"]);
  });

  it("lets the server resolve the coordinator for solution groups", async () => {
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
    await createGroupConversation(client, { title: "Group", solution_instance_id: "s1" });
    expect(client.post).toHaveBeenCalledWith("/api/agent/conversations", {
      body: expect.objectContaining({ kind: "group", solution_instance_id: "s1" }),
    });
    const body = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("coordinator_employee_id");
    expect(localStorage.getItem("aiteam.agent.conversations")).toBeNull();
  });

  it("keeps coordinator selection for free groups", async () => {
    const client = { post: vi.fn(async () => ({ id: "c2" })) } as unknown as AgentApiClient;
    await createGroupConversation(client, { title: "Free", coordinator_employee_id: "e1" });
    expect(client.post).toHaveBeenCalledWith("/api/agent/conversations", {
      body: expect.objectContaining({ kind: "group", coordinator_employee_id: "e1" }),
    });
  });
});
