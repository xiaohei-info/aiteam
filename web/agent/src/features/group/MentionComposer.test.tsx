import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppProvider } from "../../lib/app-context";
import { MentionComposer } from "./MentionComposer";

function login() {
  localStorage.setItem("aiteam.agent.token", "test-token");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify({
    user_id: "member-1",
    tenant_id: "tenant-1",
    enterprise_id: "enterprise-1",
    roles: ["member"],
    exp: 9999999999,
  }));
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.clear();
});

describe("MentionComposer", () => {
  it("submits Pi prompt mentions using the stable roster handle", async () => {
    login();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { conversation_id: "c1", idempotency_key: "key", accepted: true } }), { status: 202, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as typeof fetch;

    render(
      <MemoryRouter>
        <AppProvider>
          <MentionComposer
            conversationId="c1"
            experts={[{ employee_id: "e1", handle: "alice", display_name: "Alice", model: "test" }]}
            onDispatched={vi.fn()}
          />
        </AppProvider>
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByPlaceholderText("输入消息，@专家 触发协作…"), { target: { value: "@alice" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/agent/conversations/c1/prompt");
    expect(url).not.toContain("group-dispatch");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ text: "@alice", mentions: ["alice"] });
  });
});
