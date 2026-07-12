/**
 * W-A.2 会话列表过滤（filter prop）。
 *
 * ConversationList 在群聊页允许传 filter 谓词以排除私聊会话（parity GroupPage 复用组件）。
 * 本测试 mock listConversations 直接驱动 loadFirst / loadMore 分支。
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

import { AgentApiClient } from "../../lib/api-client";
import type { Conversation } from "./useChatApi";
import { listConversations } from "./useChatApi";

vi.mock("./useChatApi", () => ({
  listConversations: vi.fn(),
}));

import { ConversationList } from "./ConversationList";

const mockedList = vi.mocked(listConversations);

function makeConv(id: string, isPrivate = false): Conversation {
  return {
    id,
    title: isPrivate ? null : `会话${id}`,
    state: "active",
    last_read_at: null,
    last_read_message_id: null,
    entry_employee_id: isPrivate ? "emp-1" : null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => mockedList.mockReset());

function makeClient(): AgentApiClient {
  return new AgentApiClient({ fetch: vi.fn() as unknown as typeof fetch, baseUrl: "http://test" });
}

describe("ConversationList — filter", () => {
  it("首屏加载按 filter 过滤", async () => {
    mockedList.mockResolvedValue({
      items: [makeConv("c1"), makeConv("c2", true), makeConv("c3")],
      nextCursor: null,
      hasMore: false,
    } satisfies Awaited<ReturnType<typeof listConversations>>);

    render(
      <ConversationList
        client={makeClient()}
        selectedId={null}
        onSelect={() => {}}
        headerLabel="群聊"
        filter={(c) => !c.entry_employee_id}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("会话c1")).toBeInTheDocument();
      expect(screen.getByText("会话c3")).toBeInTheDocument();
    });
    expect(screen.getByRole("region", { name: "群聊会话" })).toBeInTheDocument();
    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it("加载更多按 filter 过滤", async () => {
    mockedList
      .mockResolvedValueOnce({
        items: [makeConv("c1")],
        nextCursor: "p1",
        hasMore: true,
      } as Awaited<ReturnType<typeof listConversations>>)
      .mockResolvedValueOnce({
        items: [makeConv("c2", true), makeConv("c3")],
        nextCursor: null,
        hasMore: false,
      } as Awaited<ReturnType<typeof listConversations>>);

    render(
      <ConversationList
        client={makeClient()}
        selectedId={null}
        onSelect={() => {}}
        filter={(c) => !c.entry_employee_id}
      />,
    );

    await waitFor(() => expect(screen.getByText("会话c1")).toBeInTheDocument());

    // 触发 loadMore
    await act(async () => {
      fireEvent.click(screen.getByText("加载更多"));
    });

    await waitFor(() => expect(screen.getByText("会话c3")).toBeInTheDocument());
    expect(mockedList).toHaveBeenCalledTimes(2);
  });
});
