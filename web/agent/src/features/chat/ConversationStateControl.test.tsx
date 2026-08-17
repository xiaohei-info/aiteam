import { describe, expect, it, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AgentApiClient } from "../../lib/api-client";
import { ConversationStateControl } from "./ConversationStateControl";

function makeConv(id = "c1", state = "active") {
  return { id, title: "会话A", kind: "private", state, entry_employee_id: "e1", coordinator_employee_id: null, solution_instance_id: null, schedule: null, last_read_entry_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
}
function client() {
  return new AgentApiClient({
    fetch: vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ data: { ...makeConv(), state: body.state } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
    baseUrl: "http://test",
  });
}

describe("ConversationStateControl", () => {
  it("shows valid transitions for active conversations", () => {
    render(<ConversationStateControl client={client()} conversation={makeConv()} onStateChanged={() => {}} />);
    expect(screen.getByText("活跃")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "静音" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "归档" })).toBeInTheDocument();
  });

  it("persists state through the Node Agent state endpoint", async () => {
    const onStateChanged = vi.fn();
    render(<ConversationStateControl client={client()} conversation={makeConv()} onStateChanged={onStateChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(onStateChanged).toHaveBeenCalledWith(expect.objectContaining({ state: "paused" })));
  });

  it("requires confirmation before archive", () => {
    render(<ConversationStateControl client={client()} conversation={makeConv()} onStateChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    expect(screen.getByRole("alertdialog", { name: "归档会话" })).toBeInTheDocument();
  });
});
