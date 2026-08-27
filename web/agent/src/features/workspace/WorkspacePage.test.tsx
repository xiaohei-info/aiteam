import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppProvider } from "../../lib/app-context";
import { WorkspacePage } from "./WorkspacePage";
import type { Conversation } from "./useWorkspaceApi";

const originalFetch = globalThis.fetch;

function login(): void {
  localStorage.setItem("aiteam.agent.token", "test-token");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify({ user_id: "u1", tenant_id: "t1", roles: ["member"], exp: 9_999_999_999 }));
}

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: "conversation-1",
    title: "会话",
    kind: "private",
    labels: [],
    state: "active",
    collaboration_mode: "free",
    entry_employee_id: "employee-1",
    coordinator_employee_id: null,
    solution_instance_id: null,
    schedule: null,
    permission_mode: "read-only",
    last_read_entry_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <AppProvider>
        <WorkspacePage />
      </AppProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("WorkspacePage", () => {
  it("renders a local overview with stats, quick actions, avatars, and deep links", async () => {
    login();
    const conversations = [
      conversation({ id: "private-1", title: "研究对话", entry_employee_id: "employee-1", updated_at: "2026-01-03T00:00:00.000Z" }),
      conversation({ id: "group-1", title: "软件开发", kind: "group", entry_employee_id: null, coordinator_employee_id: "employee-2", state: "draft", schedule: { schedule_id: "daily" }, updated_at: "2026-01-02T00:00:00.000Z" }),
      conversation({ id: "done-1", title: "已完成", state: "completed", updated_at: "2026-01-01T00:00:00.000Z" }),
    ];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/agent/conversations")) {
        return new Response(JSON.stringify({ data: conversations, page: { next_cursor: null, has_more: false } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/agent/grants/experts")) {
        return new Response(JSON.stringify({ data: [
          { employee_id: "employee-1", tenant_id: "t1", version: "1", handle: "research", display_name: "研究专家", avatar_url: "/avatars/research.png", revoked: false },
          { employee_id: "employee-2", tenant_id: "t1", version: "1", handle: "coord", display_name: "协调员", avatar_url: null, revoked: false },
        ], page: { next_cursor: null, has_more: false } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    renderPage();

    await waitFor(() => expect(screen.getByTestId("workspace-dashboard")).toBeInTheDocument());
    expect(screen.getByText("本地会话、协作与执行状态总览；会话内容始终保存在本机。")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-summary")).toHaveTextContent("总会话3");
    expect(screen.getByTestId("workspace-summary")).toHaveTextContent("进行中2");
    expect(screen.getByTestId("workspace-summary")).toHaveTextContent("群聊1");
    expect(screen.getByTestId("workspace-summary")).toHaveTextContent("已调度1");
    expect(screen.getByTestId("workspace-quick-actions")).toHaveTextContent("开始私聊");
    expect(screen.getByTestId("workspace-quick-actions")).toHaveTextContent("开始群聊");
    expect(screen.getAllByTestId("ws-conversation")).toHaveLength(3);
    expect(screen.getAllByTestId("workspace-recent")[0]).toBeInTheDocument();
    expect(screen.getAllByTestId("workspace-recent")[0]?.querySelectorAll('[data-aiteam-avatar="true"]')).toHaveLength(3);
    expect(screen.getByRole("link", { name: /研究对话/ })).toHaveAttribute("href", "/chat?conversation_id=private-1");
    expect(screen.getByRole("link", { name: /软件开发/ })).toHaveAttribute("href", "/group?conversation_id=group-1");
  });
});
