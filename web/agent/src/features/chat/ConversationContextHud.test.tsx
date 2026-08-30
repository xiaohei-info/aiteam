import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentApiClient } from "../../lib/api-client";
import { ConversationContextHud } from "./ConversationContextHud";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("ConversationContextHud", () => {
  it("shows a bounded unavailable state when the context endpoint fails", async () => {
    globalThis.fetch = vi.fn(async () => new Response("offline", { status: 503, headers: { "content-type": "text/plain" } })) as typeof fetch;
    const client = new AgentApiClient({ baseUrl: "http://agent.test", fetch: globalThis.fetch });
    render(<ConversationContextHud client={client} conversationId="c1" />);
    expect(await screen.findByRole("region", { name: "上下文状态" })).toHaveTextContent("错误响应");
  });

  it("shows model-supported levels and keeps a failed change visible", async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Response("failed", { status: 503, headers: { "content-type": "text/plain" } });
      return new Response(JSON.stringify({ data: {
        conversation_id: "c1", employee_id: "e1", model: { provider: "local", id: "model", name: "Model" },
        used_tokens: 120, context_window: 1_000, percentage: null, thinking_level: "off",
        available_thinking_levels: ["off", "minimal"], prompting: false,
      } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = new AgentApiClient({ baseUrl: "http://agent.test", fetch: globalThis.fetch });
    render(<ConversationContextHud client={client} conversationId="c1" />);
    await screen.findByText(/上下文：/);
    fireEvent.click(screen.getByRole("combobox", { name: "思考档位" }));
    fireEvent.click(await screen.findByRole("option", { name: "最小" }));
    expect(await screen.findByText(/错误响应/)).toBeInTheDocument();
  });

  it("renders local context usage and saves a thinking level for later prompts", async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ data: {
      conversation_id: "c1", employee_id: "e1", model: { provider: "local", id: "model", name: "Model" },
      used_tokens: 120, context_window: 1_000, percentage: 12, thinking_level: init?.method === "PATCH" ? "high" : "medium", prompting: false,
    } }), { headers: { "content-type": "application/json" } })) as typeof fetch;
    const client = new AgentApiClient({ baseUrl: "http://agent.test", fetch: globalThis.fetch });

    render(<ConversationContextHud client={client} conversationId="c1" />);

    expect(await screen.findByTestId("conversation-context-hud")).toHaveTextContent("local/model");
    expect(screen.getByTestId("conversation-context-hud")).toHaveTextContent("120");
    const selector = screen.getByRole("combobox", { name: "思考档位" });
    fireEvent.click(selector);
    fireEvent.click(await screen.findByRole("option", { name: "高" }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenLastCalledWith("http://agent.test/api/agent/conversations/c1/context", expect.objectContaining({ method: "PATCH" })));
  });
});
