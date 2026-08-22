import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentApiClient } from "../../lib/api-client";
import type { Conversation } from "./useChatApi";
import { ScheduleControl } from "./ScheduleControl";

const ISO_AT = "2026-01-01T00:00:00Z";
const CANONICAL_AT = "2026-01-01T00:00:00.000Z";

function makeConversation(schedule: Record<string, unknown> | null = null): Conversation {
  return {
    id: "c1",
    title: "会话A",
    kind: "private",
    state: "active",
    entry_employee_id: "e1",
    coordinator_employee_id: null,
    solution_instance_id: null,
    schedule,
    last_read_entry_id: null,
    created_at: ISO_AT,
    updated_at: ISO_AT,
  };
}

function makeClient(fetchMock: typeof fetch): AgentApiClient {
  return new AgentApiClient({ baseUrl: "http://test", fetch: fetchMock });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function repeatingSchedule(): Record<string, unknown> {
  return {
    schedule_id: "repeat-1",
    revision: 2,
    enabled: true,
    at: ISO_AT,
    interval_seconds: 300,
    one_shot: false,
    overlap: "skip",
    misfire: "skip",
    prompt_template: "check the inbox",
  };
}

afterEach(() => vi.restoreAllMocks());

describe("ScheduleControl", () => {
  it("saves a strict one-shot payload and exposes an empty state before setup", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const schedule = JSON.parse(String(init?.body)).schedule;
      return jsonResponse({ ...makeConversation(schedule), schedule });
    });
    const onScheduleChanged = vi.fn();
    render(<ScheduleControl client={makeClient(fetchMock as unknown as typeof fetch)} conversation={makeConversation()} onScheduleChanged={onScheduleChanged} />);

    expect(screen.getByTestId("schedule-empty")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^调度 ID/), { target: { value: "once-1" } });
    fireEvent.change(screen.getByLabelText(/^执行时间（ISO）/), { target: { value: ISO_AT } });
    fireEvent.change(screen.getByLabelText(/^提示模板/), { target: { value: "run the explicit task" } });
    fireEvent.click(screen.getByRole("button", { name: "保存调度" }));

    await waitFor(() => expect(onScheduleChanged).toHaveBeenCalledWith(expect.objectContaining({ schedule: expect.any(Object) })));
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/api/agent/conversations/c1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          schedule: {
            schedule_id: "once-1",
            revision: 1,
            enabled: true,
            at: CANONICAL_AT,
            one_shot: true,
            overlap: "skip",
            misfire: "skip",
            prompt_template: "run the explicit task",
          },
        }),
      }),
    );
    expect(screen.getByTestId("schedule-current")).toBeInTheDocument();
  });

  it("saves repeating schedules with the existing revision, anchor, interval, and enabled state", async () => {
    const existing = repeatingSchedule();
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const schedule = JSON.parse(String(init?.body)).schedule;
      return jsonResponse({ ...makeConversation(schedule), schedule });
    });
    const onScheduleChanged = vi.fn();
    render(<ScheduleControl client={makeClient(fetchMock as unknown as typeof fetch)} conversation={makeConversation(existing)} onScheduleChanged={onScheduleChanged} />);

    fireEvent.change(screen.getByLabelText(/^提示模板/), { target: { value: "check the inbox and report" } });
    fireEvent.click(screen.getByRole("button", { name: "保存调度" }));

    await waitFor(() => expect(onScheduleChanged).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      schedule: {
        schedule_id: "repeat-1",
        revision: 2,
        enabled: true,
        at: CANONICAL_AT,
        interval_seconds: 300,
        one_shot: false,
        overlap: "skip",
        misfire: "skip",
        prompt_template: "check the inbox and report",
      },
    });
    expect(screen.getByTestId("schedule-next-config")).toHaveTextContent("每 300 秒");
  });

  it("rejects invalid fields without uploading a patch", () => {
    const fetchMock = vi.fn();
    render(<ScheduleControl client={makeClient(fetchMock as unknown as typeof fetch)} conversation={makeConversation()} onScheduleChanged={() => {}} />);

    fireEvent.change(screen.getByLabelText(/^调度 ID/), { target: { value: "not safe" } });
    fireEvent.change(screen.getByLabelText(/^执行时间（ISO）/), { target: { value: "not-a-date" } });
    fireEvent.change(screen.getByLabelText(/^提示模板/), { target: { value: "prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "保存调度" }));

    expect(screen.getByTestId("schedule-error")).toHaveTextContent("调度 ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-positive repeating interval from the number input", () => {
    const fetchMock = vi.fn();
    render(<ScheduleControl client={makeClient(fetchMock as unknown as typeof fetch)} conversation={makeConversation(repeatingSchedule())} onScheduleChanged={() => {}} />);

    fireEvent.change(screen.getByLabelText(/^间隔秒数/), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "保存调度" }));

    expect(screen.getByTestId("schedule-error")).toHaveTextContent("正整数间隔秒数");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires confirmation and sends null when clearing a schedule", async () => {
    const existing = repeatingSchedule();
    const fetchMock = vi.fn(async () => jsonResponse({ ...makeConversation(null), schedule: null }));
    const onScheduleChanged = vi.fn();
    render(<ScheduleControl client={makeClient(fetchMock as unknown as typeof fetch)} conversation={makeConversation(existing)} onScheduleChanged={onScheduleChanged} />);

    fireEvent.click(screen.getByRole("button", { name: "清除调度" }));
    expect(screen.getByRole("alertdialog", { name: "清除调度配置" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认清除" }));

    await waitFor(() => expect(onScheduleChanged).toHaveBeenCalledWith(expect.objectContaining({ schedule: null })));
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/api/agent/conversations/c1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ schedule: null }) }),
    );
    expect(screen.getByTestId("schedule-empty")).toBeInTheDocument();
  });

  it.each([
    [403, "没有权限"],
    [409, "发生冲突"],
    [503, "暂不可用"],
  ])("keeps a bounded error for HTTP %s schedule failures", async (status, message) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status, code: "server_detail", detail: "do not expose this" }), {
      status,
      headers: { "content-type": "application/problem+json" },
    }));
    render(<ScheduleControl client={makeClient(fetchMock as unknown as typeof fetch)} conversation={makeConversation(repeatingSchedule())} onScheduleChanged={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "保存调度" }));
    await waitFor(() => expect(screen.getByTestId("schedule-error")).toHaveTextContent(message));
    expect(screen.getByTestId("schedule-error")).not.toHaveTextContent("do not expose this");
  });

  it("maps a network failure without leaking the fetch error", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("private network detail"); });
    render(<ScheduleControl client={makeClient(fetchMock as unknown as typeof fetch)} conversation={makeConversation(repeatingSchedule())} onScheduleChanged={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "保存调度" }));
    await waitFor(() => expect(screen.getByTestId("schedule-error")).toHaveTextContent("网络异常"));
    expect(screen.getByTestId("schedule-error")).not.toHaveTextContent("private network detail");
  });
});
