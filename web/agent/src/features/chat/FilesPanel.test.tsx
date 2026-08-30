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
  it("keeps an upstream file-list error visible", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/events")) return new Response(new ReadableStream({ start(controller) { controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
      return new Response("offline", { status: 503, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    const client = new AgentApiClient({ baseUrl: "http://agent.test", fetch: globalThis.fetch });
    render(<FilesPanel client={client} conversationId="c1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/错误响应|加载失败/);
  });

  it("shows authenticated attachments and generated artifacts with safe text preview and download actions", async () => {
    const attachment = file({});
    const artifact = file({ id: "f1", kind: "artifact", filename: "result.ts", mime_type: "text/typescript" });
    const image = file({ id: "f2", kind: "artifact", filename: "chart.png", mime_type: "image/png" });
    const pdf = file({ id: "f3", kind: "artifact", filename: "report.pdf", mime_type: "application/pdf" });
    const binary = file({ id: "f4", kind: "artifact", filename: "deck.pptx", mime_type: "application/vnd.ms-powerpoint" });
    const stream = () => new Response(new ReadableStream({ start(controller) { controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/attachments")) return new Response(JSON.stringify({ data: [attachment], page: { next_cursor: null, has_more: false } }), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/artifacts")) return new Response(JSON.stringify({ data: [artifact, image, pdf, binary], page: { next_cursor: null, has_more: false } }), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/events")) return stream();
      return new Response("export const answer = 42;", { headers: { "content-type": "text/typescript" } });
    }) as typeof fetch;
    const client = new AgentApiClient({ baseUrl: "http://agent.test", fetch: globalThis.fetch });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });

    render(<FilesPanel client={client} conversationId="c1" />);

    expect(await screen.findByText("notes.md")).toBeInTheDocument();
    expect(screen.getByText("result.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看 result.ts" }));
    expect(await screen.findByText("export const answer = 42;")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "下载 result.ts" }).at(-1)!);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("http://agent.test/api/agent/conversations/c1/artifacts/f1", expect.objectContaining({ method: "GET" })));

    fireEvent.click(screen.getByRole("button", { name: "查看 chart.png" }));
    expect(await screen.findByTestId("file-preview-image")).toHaveAttribute("src", "blob:test");
    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    fireEvent.click(screen.getByRole("button", { name: "查看 report.pdf" }));
    expect(await screen.findByTestId("file-preview-pdf")).toHaveAttribute("src", "blob:test");
    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    fireEvent.click(screen.getByRole("button", { name: "查看 deck.pptx" }));
    expect(await screen.findByText("此文件类型不支持安全预览，请下载后查看。")).toBeInTheDocument();
  });
});
