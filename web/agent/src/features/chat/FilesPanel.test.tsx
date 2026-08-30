import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentApiClient } from "../../lib/api-client";
import { FilesPanel } from "./FilesPanel";
import type { LocalFile } from "./useChatApi";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function file(overrides: Partial<LocalFile>): LocalFile {
  return {
    id: "a1",
    conversation_id: "c1",
    tenant_id: "tenant-1",
    member_id: "member-1",
    kind: "attachment",
    filename: "notes.md",
    mime_type: "text/markdown",
    byte_size: 12,
    sha256: "hash",
    created_at: "2026-01-01T00:00:00Z",
    referenced_at: null,
    ...overrides,
  };
}

describe("FilesPanel", () => {
  it("shows authenticated attachments and generated artifacts with safe text preview and download actions", async () => {
    const attachment = file({});
    const artifact = file({ id: "f1", kind: "artifact", filename: "result.ts", mime_type: "text/typescript" });
    const stream = () => new Response(new ReadableStream({ start(controller) { controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attachments")) return new Response(JSON.stringify({ data: [attachment], page: { next_cursor: null, has_more: false } }), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/artifacts")) return new Response(JSON.stringify({ data: [artifact], page: { next_cursor: null, has_more: false } }), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/events")) return stream();
      return new Response("export const answer = 42;", { headers: { "content-type": "text/typescript" } });
    }) as typeof fetch;
    const client = new AgentApiClient({ baseUrl: "http://agent.test", fetch: globalThis.fetch });

    render(<FilesPanel client={client} conversationId="c1" />);

    expect(await screen.findByText("notes.md")).toBeInTheDocument();
    expect(screen.getByText("result.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看 result.ts" }));
    expect(await screen.findByText("export const answer = 42;")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "下载 result.ts" }).at(-1)!);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("http://agent.test/api/agent/conversations/c1/artifacts/f1", expect.objectContaining({ method: "GET" })));
  });
});
