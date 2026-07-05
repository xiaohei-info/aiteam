/**
 * W-A.3 群聊 API 适配层单元测试。
 *
 * useGroupApi.ts 是纯 API 适配（不调 fetch / 不挂 React），所以本测试直接
 * 构造一个 mock AgentApiClient，验证：
 * - listSolutionInstances / createConversationFromSolution / createFreeConversation
 *   的端点路径、请求体、空 envelope 兜底逻辑。
 */

import { describe, expect, it, vi } from "vitest";

import type { AgentApiClient } from "../../lib/api-client";
import {
  listLoadedExperts,
  groupDispatch,
  listSolutionInstances,
  createConversationFromSolution,
  createFreeConversation,
  type LoadedExpertProjection,
  type SolutionProjection,
  type DispatchResult,
} from "./useGroupApi";

function makeClient(listGetResult: unknown, postResult: unknown): AgentApiClient {
  return {
    listGet: vi.fn(async () => listGetResult),
    post: vi.fn(async () => postResult),
    put: vi.fn(async () => postResult),
  } as unknown as AgentApiClient;
}

const envelope = (items: unknown) => ({
  items,
  page: { next_cursor: null, has_more: false },
});

describe("useGroupApi — listLoadedExperts", () => {
  it("GET /api/agent/grants/experts 返回 items", async () => {
    const data: LoadedExpertProjection[] = [
      { employee_id: "e1", tenant_id: "t1", version: "v1", handle: "专家A", display_name: "专家A", revoked: false },
    ];
    const result = await listLoadedExperts(makeClient(envelope(data), null) as AgentApiClient);
    expect(result).toEqual(data);
  });
});

describe("useGroupApi — groupDispatch", () => {
  it("POST .../group-dispatch，body 含 text + experts，返回 DispatchResult", async () => {
    const dispatch: DispatchResult = { triggered_handles: ["专家A"], runs: [] };
    const client = makeClient(envelope([]), dispatch);
    const r = await groupDispatch(client as AgentApiClient, "c1", { text: "@专家A 你好", experts: [] });
    expect(r).toEqual(dispatch);
    expect(client.post).toHaveBeenCalledWith(
      "/api/agent/conversations/c1/group-dispatch",
      { body: { text: "@专家A 你好", experts: [] } },
    );
  });

  it("空 envelope 抛错", async () => {
    await expect(
      groupDispatch(makeClient(envelope([]), null) as AgentApiClient, "c1", { text: "x", experts: [] }),
    ).rejects.toThrow(/empty envelope/);
  });
});

describe("useGroupApi — listSolutionInstances", () => {
  it("GET /api/agent/grants/solutions 返回 items", async () => {
    const data: SolutionProjection[] = [
      {
        solution_instance_id: "si-1",
        display_name: "电商群",
        version: "v1",
        planner_prompt: "p",
        subtask_prompt: "s",
        aggregate_prompt: "a",
      },
    ];
    const result = await listSolutionInstances(makeClient(envelope(data), null) as AgentApiClient);
    expect(result).toEqual(data);
  });
});

describe("useGroupApi — createConversationFromSolution", () => {
  it("POST /api/agent/conversations，body 含 solution_instance_id + title", async () => {
    const conv = { id: "c-new", title: "群聊X", state: "active" };
    const client = makeClient(envelope([]), conv);
    const r = await createConversationFromSolution(client as AgentApiClient, {
      solution_instance_id: "si-1",
      title: "群聊X",
    });
    expect(r).toEqual(conv);
    expect(client.post).toHaveBeenCalledWith("/api/agent/conversations", {
      body: { title: "群聊X", solution_instance_id: "si-1" },
    });
  });

  it("空 title 落 null", async () => {
    const client = makeClient(envelope([]), { id: "c" });
    await createConversationFromSolution(client as AgentApiClient, { solution_instance_id: "si-1" });
    expect(client.post).toHaveBeenCalledWith("/api/agent/conversations", {
      body: { title: null, solution_instance_id: "si-1" },
    });
  });

  it("空 envelope 抛错", async () => {
    await expect(
      createConversationFromSolution(makeClient(envelope([]), null) as AgentApiClient, {
        solution_instance_id: "si-1",
      }),
    ).rejects.toThrow(/empty envelope/);
  });
});

describe("useGroupApi — createFreeConversation", () => {
  it("POST /api/agent/conversations，body 仅 title（无 solution_instance_id）", async () => {
    const conv = { id: "c-free", title: "自由群", state: "active" };
    const client = makeClient(envelope([]), conv);
    const r = await createFreeConversation(client as AgentApiClient, { title: "自由群" });
    expect(r).toEqual(conv);
    expect(client.post).toHaveBeenCalledWith("/api/agent/conversations", {
      body: { title: "自由群" },
    });
  });

  it("空 title → null + 空 envelope 兜底抛错", async () => {
    const client = makeClient(envelope([]), null);
    await expect(createFreeConversation(client as AgentApiClient, {})).rejects.toThrow(/empty envelope/);
  });
});
