import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { AppProvider } from "../../lib/app-context";
import { GroupPage } from "./GroupPage";
import type { Conversation } from "../chat/useChatApi";

const originalFetch = globalThis.fetch;

const mocks = vi.hoisted(() => ({
  createGroupConversation: vi.fn(),
  listConversationParticipants: vi.fn(),
  listLoadedExperts: vi.fn(),
  listSolutionInstances: vi.fn(),
}));

vi.mock("./useGroupApi", () => ({
  createGroupConversation: mocks.createGroupConversation,
  listConversationParticipants: mocks.listConversationParticipants,
  listLoadedExperts: mocks.listLoadedExperts,
  listSolutionInstances: mocks.listSolutionInstances,
}));

vi.mock("../chat/TimelineView", () => ({ TimelineView: () => null }));
vi.mock("../chat/MessageComposer", () => ({ MessageComposer: () => null }));
vi.mock("./GroupExpertRoster", () => ({ GroupExpertRoster: () => null }));

afterEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.clear();
  vi.clearAllMocks();
});

function login(): void {
  localStorage.setItem("aiteam.agent.token", "test-token");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify({ user_id: "u1", tenant_id: "t1", roles: ["member"], exp: 9999999999 }));
}

function LocationProbe() {
  const [params] = useSearchParams();
  return <output data-testid="conversation-location">{params.get("conversation_id") ?? ""}</output>;
}

function conversation(id: string, title: string): Conversation {
  return {
    id,
    title,
    kind: "group",
    state: "active",
    entry_employee_id: null,
    coordinator_employee_id: "e1",
    solution_instance_id: null,
    schedule: null,
    last_read_entry_id: null,
    created_at: "2026-08-24T12:00:00Z",
    updated_at: "2026-08-24T12:00:00Z",
  };
}

describe("GroupPage conversation creation", () => {
  it("updates the deep-link to the newly created group conversation", async () => {
    login();
    const existing = conversation("group-old", "旧群聊");
    const created = conversation("group-new", "旧群聊");
    let conversations = [existing];
    mocks.listLoadedExperts.mockResolvedValue([
      { employee_id: "e1", tenant_id: "t1", version: "v1", handle: "coordinator", display_name: "协调员", revoked: false },
    ]);
    mocks.listSolutionInstances.mockResolvedValue([]);
    mocks.listConversationParticipants.mockResolvedValue([
      { employee_id: "e1", display_name: "协调员", handle: "coordinator", role_title: null, department_ids: [], role: "coordinator", available: true },
    ]);
    mocks.createGroupConversation.mockImplementation(async () => {
      conversations = [created, existing];
      return created;
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(JSON.stringify({ data: conversations, page: { next_cursor: null, has_more: false } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    render(
      <MemoryRouter initialEntries={["/group?conversation_id=group-old"]}>
        <LocationProbe />
        <AppProvider><GroupPage /></AppProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "旧群聊" })).toBeInTheDocument();
    expect(screen.getByTestId("group-chat-layout")).toContainElement(screen.getByTestId("group-chat-content"));
    expect(screen.getByTestId("group-conversation-workspace")).toContainElement(screen.getByTestId("conversation-files-panel"));
    fireEvent.click(screen.getByRole("button", { name: "与旧群聊新建对话" }));

    await waitFor(() => expect(mocks.createGroupConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "旧群聊", coordinator_employee_id: "e1" }),
    ));
    await waitFor(() => expect(screen.getByTestId("conversation-location")).toHaveTextContent("group-new"));
  });
});
