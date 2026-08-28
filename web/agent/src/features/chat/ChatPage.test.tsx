import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { AppProvider } from "../../lib/app-context";
import type { Conversation } from "./useChatApi";
import { ChatPage } from "./ChatPage";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.clear();
});

function login(): void {
  localStorage.setItem("aiteam.agent.token", "test-token");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify({ user_id: "u1", tenant_id: "t1", roles: ["member"], exp: 9999999999 }));
}

function ConversationLocation() {
  const [params] = useSearchParams();
  return <output data-testid="conversation-location">{params.get("conversation_id") ?? ""}</output>;
}

function conversation(id: string, employeeId: string, title: string, updatedAt: string): Conversation {
  return {
    id,
    title,
    kind: "private",
    state: "active",
    entry_employee_id: employeeId,
    coordinator_employee_id: null,
    solution_instance_id: null,
    schedule: null,
    last_read_entry_id: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

describe("ChatPage employee navigation", () => {
  it("groups conversations by employee and exposes history, new chat, and schedule as icon actions", async () => {
    login();
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    let conversations = [
      conversation("c2", "e1", "系统测试员", "2026-08-24T12:00:00Z"),
      conversation("c1", "e1", "系统测试员", "2026-08-23T12:00:00Z"),
      conversation("c-other", "e2", "数据分析师", "2026-08-22T12:00:00Z"),
    ];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (method === "POST" && url.includes("/api/agent/conversations")) {
        const created = conversation("c3", "e1", "系统测试员", "2026-08-24T13:00:00Z");
        conversations = [created, ...conversations];
        return new Response(JSON.stringify({ data: created }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/events")) return new Response(new ReadableStream({ start(controller) { controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
      if (url.includes("/entries")) return new Response(JSON.stringify({ data: { conversation_id: url.includes("/c1/") ? "c1" : "c2", entries: [] } }), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/state")) return new Response(JSON.stringify({ data: { conversation_id: "c2", state: "active", prompting: false } }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ data: conversations, page: { next_cursor: null, has_more: false } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    render(
      <MemoryRouter initialEntries={["/chat?conversation_id=c2"]}>
        <ConversationLocation />
        <AppProvider><ChatPage /></AppProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("conversation-c2"));
    expect(screen.queryByTestId("conversation-c1")).not.toBeInTheDocument();
    expect(screen.getByText("2 个对话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "历史对话" })).toHaveTextContent(/^$/);
    expect(screen.getByRole("button", { name: "设置调度" })).toHaveTextContent(/^$/);
    expect(screen.getByRole("button", { name: "与系统测试员新建对话" })).not.toHaveTextContent("新建对话");

    fireEvent.click(screen.getByRole("button", { name: "历史对话" }));
    expect(await screen.findByTestId("history-c2")).toBeInTheDocument();
    expect(screen.getByTestId("history-c1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("history-c1"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "历史对话" })).not.toBeInTheDocument());
    expect(requests.some(({ url }) => url.includes("/conversations/c1/entries"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "设置调度" }));
    expect(await screen.findByRole("dialog", { name: "调度配置" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭调度配置" }));

    fireEvent.click(screen.getByRole("button", { name: "与系统测试员新建对话" }));
    await waitFor(() => expect(requests.some(({ method, body }) => method === "POST" && body?.includes('"entry_employee_id":"e1"'))).toBe(true));
    expect(await screen.findByTestId("conversation-c3")).toBeInTheDocument();
    expect(screen.getByText("3 个对话")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-location")).toHaveTextContent("c3");
  });

  it("opens the conversation requested by a workspace deep link", async () => {
    login();
    const selected = conversation("deep-link", "e1", "系统测试员", "2026-08-24T12:00:00Z");
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/events")) return new Response(new ReadableStream({ start(controller) { controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
      if (url.includes("/entries")) return new Response(JSON.stringify({ data: { conversation_id: selected.id, entries: [] } }), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/state")) return new Response(JSON.stringify({ data: { conversation_id: selected.id, state: "active", prompting: false } }), { headers: { "content-type": "application/json" } });
      if (url.includes("/grants/experts")) return new Response(JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ data: [selected], page: { next_cursor: null, has_more: false } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    render(<MemoryRouter initialEntries={["/chat?conversation_id=deep-link"]}><AppProvider><ChatPage /></AppProvider></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "系统测试员" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "会话工作区" })).toBeInTheDocument();
  });
});
