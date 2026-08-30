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
