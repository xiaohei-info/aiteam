import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AppProvider } from "../../lib/app-context";
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

describe("ChatPage schedule placement", () => {
  it("keeps the large schedule form out of the chat path until explicitly opened", async () => {
    login();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/events")) return new Response(new ReadableStream({ start(controller) { controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
      if (url.includes("/entries")) return new Response(JSON.stringify({ data: { conversation_id: "c1", entries: [] } }), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/state")) return new Response(JSON.stringify({ data: { conversation_id: "c1", state: "active", prompting: false } }), { headers: { "content-type": "application/json" } });
      if (url.includes("/grants/experts")) return new Response(JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ data: [{ id: "c1", title: "系统测试员", kind: "private", state: "active", entry_employee_id: "e1", coordinator_employee_id: null, solution_instance_id: null, schedule: null, last_read_entry_id: null, created_at: "now", updated_at: "now" }], page: { next_cursor: null, has_more: false } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    render(<MemoryRouter><AppProvider><ChatPage /></AppProvider></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "系统测试员" }));
    expect(screen.queryByTestId("schedule-control")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "设置调度" }));
    expect(await screen.findByRole("dialog", { name: "调度配置" })).toBeInTheDocument();
    expect(screen.getByTestId("schedule-control")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭调度配置" }));
    await waitFor(() => expect(screen.queryByTestId("schedule-control")).not.toBeInTheDocument());
  });
});
