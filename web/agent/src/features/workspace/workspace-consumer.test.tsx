import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { AgentApiClient } from "../../lib/api-client";
import { MessageSearch } from "./MessageSearch";
import { WORK_HISTORY_POLL_INTERVAL_MS, WorkInsights } from "./WorkInsights";
import { getUsageStatistics, listWorkRecordChanges, listWorkRecords } from "./useWorkspaceApi";

function client(overrides: Partial<AgentApiClient> = {}): AgentApiClient {
  return {
    listGet: vi.fn(),
    get: vi.fn(),
    ...overrides,
  } as unknown as AgentApiClient;
}

function record(id: string) {
  return {
    id,
    employee_id: "employee-1",
    employee_display_name: "研究专家",
    conversation_id: "conversation-1",
    conversation_title: "本地研究",
    provenance: "live" as const,
    outcome: "succeeded" as const,
    reason: null,
    time_basis: "prompt_start" as const,
    occurred_at: "2026-09-01T09:00:00Z",
    started_at: "2026-09-01T09:00:00Z",
    ended_at: "2026-09-01T09:01:00Z",
    updated_at: "2026-09-01T09:01:00Z",
    first_entry_at: null,
    last_entry_at: null,
    input_entry_ref: null,
    output_entry_ref: null,
    source_type: "human" as const,
    source_id: null,
    task_summary: "整理研究资料",
    result_summary: "已完成",
    usage: null,
  };
}

const usage = {
  scope: "member_local" as const,
  coverage: "recorded_hourly_summaries" as const,
  employee_id: null,
  window_start: null,
  window_end: null,
  bucket: "utc_hour" as const,
  execution_count: 1,
  succeeded_count: 1,
  non_success_count: 0,
  input_tokens: 10,
  output_tokens: 5,
  cache_tokens: 0,
  token_total: 15,
  duration_ms_total: 1_000,
  currency: "USD" as const,
  cost_total: null,
  known_cost_total: "0.000000000000",
  cost_minor: null,
  pricing_status: "unknown" as const,
  unpriced_execution_count: 1,
  excluded_summary_count: 0,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="workspace-location">{location.pathname}{location.search}</output>;
}

describe("Agent workspace read consumers", () => {
  it("keeps work history pagination and changes waterline separate", async () => {
    const api = client({ listGet: vi.fn()
      .mockResolvedValueOnce({ items: [record("work-1")], page: { next_cursor: "before-1", has_more: true }, meta: { after: "changes-1" } })
      .mockResolvedValueOnce({ items: [{ operation: "delete", record_id: "work-1" }], page: { next_cursor: "changes-2", has_more: false } }) });
    await expect(listWorkRecords(api, { limit: 20 })).resolves.toMatchObject({ items: [{ id: "work-1" }], nextCursor: "before-1", hasMore: true, after: "changes-1" });
    await expect(listWorkRecordChanges(api, { after: "changes-1", limit: 100 })).resolves.toMatchObject({ items: [{ operation: "delete" }], nextCursor: "changes-2" });
    expect(api.listGet).toHaveBeenNthCalledWith(2, "/api/agent/work-records/changes", { query: { after: "changes-1", limit: 100 } });
  });

  it("renders real usage unknowns and searches local messages with cursor pagination", async () => {
    const api = client({
      get: vi.fn().mockResolvedValue(usage),
      listGet: vi.fn()
        .mockResolvedValueOnce({ items: [{ conversation_id: "conversation-1", conversation_title: "本地研究", entry_ref: "entry-1", id: "pi-1", participant_employee_id: "employee-1", timestamp: "2026-09-01T09:00:00Z", role: "assistant", snippet: "本地结果" }], page: { next_cursor: "search-2", has_more: true } })
        .mockResolvedValueOnce({ items: [], page: { next_cursor: null, has_more: false } }),
    });
    await expect(getUsageStatistics(api)).resolves.toEqual(usage);
    render(<MemoryRouter><MessageSearch client={api} /></MemoryRouter>);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索词" }), { target: { value: "结果" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(await screen.findByText("本地结果")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更早结果" }));
    await waitFor(() => expect(api.listGet).toHaveBeenLastCalledWith("/api/agent/messages/search", { query: expect.objectContaining({ q: "结果", cursor: "search-2", limit: 50 }) }));
    const insightsApi = client({
      listGet: vi.fn().mockResolvedValue({ items: [], page: { next_cursor: null, has_more: false }, meta: { after: "" } }),
      get: vi.fn().mockResolvedValue(usage),
    });
    render(<WorkInsights client={insightsApi} />);
    expect(await screen.findByText("费用未知")).toBeInTheDocument();
  });

  it("renders every fetched history page and refreshes usage with work changes", async () => {
    vi.useFakeTimers();
    const firstPage = Array.from({ length: 9 }, (_, index) => record(`work-${index + 1}`));
    const api = client({
      listGet: vi.fn()
        .mockResolvedValueOnce({ items: firstPage, page: { next_cursor: "history-2", has_more: true }, meta: { after: "change-1" } })
        .mockResolvedValueOnce({ items: [record("work-10")], page: { next_cursor: null, has_more: false } })
        .mockResolvedValueOnce({ items: [], page: { next_cursor: "change-2", has_more: false } }),
      get: vi.fn()
        .mockResolvedValueOnce(usage)
        .mockResolvedValueOnce({ ...usage, execution_count: 2, token_total: 30 }),
    });
    render(<WorkInsights client={api} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByTestId("work-history-record")).toHaveLength(9);
    fireEvent.click(screen.getByRole("button", { name: "加载更早记录" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByTestId("work-history-record")).toHaveLength(10);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORK_HISTORY_POLL_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("usage-statistics-summary")).toHaveTextContent("执行次数2");
    expect(api.listGet).toHaveBeenLastCalledWith("/api/agent/work-records/changes", { query: { after: "change-1", limit: 100 } });
  });

  it("resolves a search hit's existing conversation kind before routing to a group", async () => {
    const api = client({
      listGet: vi.fn().mockResolvedValue({
        items: [{ conversation_id: "group-1", conversation_title: "协作群", entry_ref: "entry-group", id: "pi-1", participant_employee_id: "employee-1", timestamp: "2026-09-01T09:00:00Z", role: "assistant", snippet: "群聊结果" }],
        page: { next_cursor: null, has_more: false },
      }),
      get: vi.fn().mockResolvedValue({ id: "group-1", kind: "group" }),
    });
    render(<MemoryRouter><LocationProbe /><MessageSearch client={api} /></MemoryRouter>);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索词" }), { target: { value: "群聊" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    const hit = await screen.findByTestId("message-search-hit-entry-group");
    fireEvent.click(hit);
    await waitFor(() => expect(screen.getByTestId("workspace-location")).toHaveTextContent("/group?conversation_id=group-1&entry_ref=entry-group"));
    expect(api.get).toHaveBeenCalledWith("/api/agent/conversations/group-1");
  });

  it("does not invent work records when the local read is unavailable", async () => {
    const api = client({
      listGet: vi.fn().mockRejectedValue(new Error("local read unavailable")),
      get: vi.fn().mockResolvedValue(null),
    });
    render(<WorkInsights client={api} />);
    expect(await screen.findByText("local read unavailable")).toBeInTheDocument();
    expect(screen.getByText("用量统计暂不可用")).toBeInTheDocument();
    expect(screen.queryByText("执行次数0")).not.toBeInTheDocument();
  });

  it("shows a search error without retaining stale results", async () => {
    const api = client({ listGet: vi.fn().mockRejectedValue(new Error("search unavailable")) });
    render(<MemoryRouter><MessageSearch client={api} /></MemoryRouter>);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索词" }), { target: { value: "本地" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(await screen.findByTestId("message-search-error")).toHaveTextContent("search unavailable");
    expect(screen.queryByTestId("message-search-results")).not.toBeInTheDocument();
  });
});
