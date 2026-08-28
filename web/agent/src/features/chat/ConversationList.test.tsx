import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentApiClient } from "../../lib/api-client";
import type { Conversation } from "./useChatApi";
import { listConversations } from "./useChatApi";

vi.mock("./useChatApi", () => ({ listConversations: vi.fn() }));

import { ConversationList } from "./ConversationList";

const mockedList = vi.mocked(listConversations);

function makeConv(id: string, kind: "private" | "group" = "group", employeeId = "emp-1"): Conversation {
  return {
    id,
    title: `${kind === "private" ? "员工" : "群聊"}${id}`,
    kind,
    state: "active",
    entry_employee_id: kind === "private" ? employeeId : null,
    coordinator_employee_id: kind === "group" ? "emp-2" : null,
    solution_instance_id: null,
    schedule: null,
    last_read_entry_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => mockedList.mockReset());

function makeClient(): AgentApiClient {
  return new AgentApiClient({ fetch: vi.fn() as unknown as typeof fetch, baseUrl: "http://test" });
}

describe("ConversationList", () => {
  it("automatically loads all pages and keeps the group navigation filtered", async () => {
    mockedList
      .mockResolvedValueOnce({ items: [makeConv("c1")], nextCursor: "p1", hasMore: true })
      .mockResolvedValueOnce({ items: [makeConv("c2", "private"), makeConv("c3")], nextCursor: null, hasMore: false });

    render(
      <ConversationList
        client={makeClient()}
        selectedId={null}
        onSelect={() => {}}
        headerLabel="群聊"
        filter={(conversation) => conversation.kind === "group"}
      />,
    );

    expect(await screen.findByText("群聊c1")).toBeInTheDocument();
    expect(await screen.findByText("群聊c3")).toBeInTheDocument();
    expect(screen.queryByText("员工c2")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "群聊列表" })).toBeInTheDocument();
    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  it("shows one friend per employee and selects the newest conversation", async () => {
    const onSelect = vi.fn();
    mockedList.mockResolvedValue({
      items: [makeConv("new", "private", "emp-1"), makeConv("old", "private", "emp-1"), makeConv("other", "private", "emp-2")],
      nextCursor: null,
      hasMore: false,
    });

    render(
      <ConversationList
        client={makeClient()}
        selectedId="old"
        onSelect={onSelect}
        headerLabel="数字员工"
        groupByEmployee
      />,
    );

    expect(await screen.findByText("员工new")).toBeInTheDocument();
    expect(screen.queryByText("员工old")).not.toBeInTheDocument();
    expect(screen.getByText("2 个对话")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-other")).toBeInTheDocument();

    await act(async () => fireEvent.click(screen.getByTestId("conversation-new")));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "new", entry_employee_id: "emp-1" }));
  });

  it("groups new group conversations under the same solution", async () => {
    const onSelect = vi.fn();
    const newest = { ...makeConv("new-group"), title: "软件开发", solution_instance_id: "solution-1" };
    const previous = { ...makeConv("old-group"), title: "软件开发", solution_instance_id: "solution-1" };
    const other = { ...makeConv("other-group"), title: "数据分析", solution_instance_id: "solution-2" };
    mockedList.mockResolvedValue({ items: [newest, previous, other], nextCursor: null, hasMore: false });

    render(
      <ConversationList
        client={makeClient()}
        selectedId="old-group"
        onSelect={onSelect}
        headerLabel="群聊"
        filter={(conversation) => conversation.kind === "group"}
        groupByGroup
      />,
    );

    expect(await screen.findByTestId("conversation-new-group")).toBeInTheDocument();
    expect(screen.queryByTestId("conversation-old-group")).not.toBeInTheDocument();
    expect(screen.getByText("2 个对话")).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByTestId("conversation-new-group")));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "new-group", solution_instance_id: "solution-1" }));
  });
});
