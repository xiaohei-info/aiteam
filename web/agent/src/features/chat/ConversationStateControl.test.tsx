/**
 * W-A.2 会话状态控制测试（#314）。
 *
 * 覆盖：
 * 1. 按当前状态渲染正确的合法转换按钮（active → 暂停/静音/归档）
 * 2. 点击按钮调用 PUT /state 并触发 onStateChanged
 * 3. 归档后（终态）不再渲染动作按钮
 * 4. API 失败时展示错误文案
 * 5. setConversationState API 函数调用 client.put 到正确路径
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

import { AgentApiClient } from "../../lib/api-client";
import { ConversationStateControl } from "./ConversationStateControl";

vi.mock("./useChatApi", () => ({
  setConversationState: vi.fn(),
}));

import { setConversationState } from "./useChatApi";

const mockedSetState = vi.mocked(setConversationState);

function makeConv(id: string, state: string) {
  return { id, title: "会话A", state, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
}

function makeClient() {
  return new AgentApiClient({ fetch: vi.fn() as unknown as typeof fetch, baseUrl: "http://test" });
}

afterEach(() => {
  mockedSetState.mockReset();
});

describe("ConversationStateControl — active 状态", () => {
  it("活跃会话展示 暂停/静音/归档 三个动作", async () => {
    const client = makeClient();
    mockedSetState.mockResolvedValue(makeConv("c1", "active"));
    render(
      <ConversationStateControl
        client={client}
        conversation={makeConv("c1", "active")}
        onStateChanged={() => {}}
      />,
    );

    expect(screen.getByText("活跃")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "静音" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "归档" })).toBeInTheDocument();
  });

  it("点击暂停调用 PUT /state 并触发回调", async () => {
    const client = makeClient();
    const onStateChanged = vi.fn();
    mockedSetState.mockResolvedValue(makeConv("c1", "paused"));

    render(
      <ConversationStateControl
        client={client}
        conversation={makeConv("c1", "active")}
        onStateChanged={onStateChanged}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    });

    await waitFor(() => {
      expect(mockedSetState).toHaveBeenCalledWith(client, "c1", "paused");
    });
    expect(onStateChanged).toHaveBeenCalledWith(expect.objectContaining({ state: "paused" }));
  });
});

describe("ConversationStateControl — paused 状态", () => {
  it("已暂停会话展示 恢复/归档", () => {
    const client = makeClient();
    render(
      <ConversationStateControl
        client={client}
        conversation={makeConv("c1", "paused")}
        onStateChanged={() => {}}
      />,
    );

    expect(screen.getByText("已暂停")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "归档" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();
  });
});

describe("ConversationStateControl — muted 状态", () => {
  it("已静音会话展示 取消静音/归档", () => {
    const client = makeClient();
    render(
      <ConversationStateControl
        client={client}
        conversation={makeConv("c1", "muted")}
        onStateChanged={() => {}}
      />,
    );

    expect(screen.getByText("已静音")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消静音" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "归档" })).toBeInTheDocument();
  });
});

describe("ConversationStateControl — archived 终态", () => {
  it("已归档会话不展示动作按钮", () => {
    const client = makeClient();
    render(
      <ConversationStateControl
        client={client}
        conversation={makeConv("c1", "archived")}
        onStateChanged={() => {}}
      />,
    );

    expect(screen.getByText("已归档")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "静音" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "归档" })).not.toBeInTheDocument();
    expect(screen.getByText("终态，无可执行操作")).toBeInTheDocument();
  });
});

describe("ConversationStateControl — 错误处理", () => {
  it("API 失败时展示错误文案", async () => {
    const client = makeClient();
    mockedSetState.mockRejectedValue(new Error("请求失败"));

    render(
      <ConversationStateControl
        client={client}
        conversation={makeConv("c1", "active")}
        onStateChanged={() => {}}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    });

    await waitFor(() => {
      expect(screen.getByText("状态变更失败")).toBeInTheDocument();
    });
  });
});

describe("setConversationState API", () => {
  it("调用 client.put 到正确路径并返回更新后的会话", async () => {
    const client = makeClient();
    const updated = makeConv("c1", "paused");
    const putSpy = vi.spyOn(client, "put").mockResolvedValue(updated);

    const realModule = await vi.importActual<typeof import("./useChatApi")>("./useChatApi");
    const result = await realModule.setConversationState(client, "c1", "paused");

    expect(putSpy).toHaveBeenCalledWith(
      "/api/agent/conversations/c1/state",
      { body: { state: "paused" } },
    );
    expect(result!.state).toBe("paused");
  });
});
