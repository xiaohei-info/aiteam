/**
 * AITEAM-693：RunsPanel 追溯（provenance）展开 + 运行态/追溯空分支。
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { AppProvider } from "../../lib/app-context";
import { RunsPanel } from "./RunsPanel";
import { listRuns, getRunProvenance } from "./useRunsApi";

vi.mock("./useRunsApi", () => ({
  listRuns: vi.fn(() => Promise.resolve([])),
  listTasks: vi.fn(() => Promise.resolve([])),
  cancelRun: vi.fn(() => Promise.resolve()),
  retryRun: vi.fn(() => Promise.resolve(null)),
  getRunProvenance: vi.fn(() => Promise.resolve(null)),
}));

const mockedList = listRuns as unknown as ReturnType<typeof vi.fn>;
const mockedProv = getRunProvenance as unknown as ReturnType<typeof vi.fn>;

describe("RunsPanel provenance", () => {
  it("点击追溯拉取 run provenance 并展示 snapshot/runtime/model/skills", async () => {
    const run = { id: "run_abc123def456", conversation_id: "c", status: "succeeded",
      trigger_type: "manual_run", execution_mode: "single_agent" };
    mockedList.mockResolvedValueOnce([run]);
    mockedProv.mockResolvedValueOnce({
      meta: { run_id: run.id, status: "succeeded", trigger_type: "manual_run", execution_mode: "single_agent" },
      binding: { employee_id: "emp-1", snapshot_version: "snap-1", snapshot_source: "frozen",
        runtime: "hermes", provider_ref: "openai", skill_refs: ["code-review"] },
      capability: { model: "gpt", knowledge_refs: ["kb-backend"], connector_refs: ["slack"],
        memory_policy: { ref: "mem0" }, persona_preview: "资深工程师" },
    });

    const client = { baseUrl: "http://test" } as never;
    render(
      <AppProvider>
        <RunsPanel client={client} conversationId="c" refreshSignal={0} />
      </AppProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "追溯" }));
    expect(await screen.findByText("snap-1")).toBeInTheDocument();
    expect(await screen.findByText("hermes")).toBeInTheDocument();
    expect(await screen.findByText("gpt")).toBeInTheDocument();
    expect(await screen.findByText("code-review")).toBeInTheDocument();
    expect(await screen.findByText("kb-backend")).toBeInTheDocument();
  });
});

describe("RunsPanel 运行态/追溯空分支", () => {
  it("running 状态展示“取消”按钮", async () => {
    const run = { id: "run_run789spin01", conversation_id: "c", status: "running",
      trigger_type: "manual_run", execution_mode: "single_agent" };
    mockedList.mockResolvedValueOnce([run]);
    const client = { baseUrl: "http://test" } as never;
    render(
      <AppProvider>
        <RunsPanel client={client} conversationId="c" refreshSignal={0} />
      </AppProvider>,
    );
    expect(await screen.findByRole("button", { name: "取消" })).toBeInTheDocument();
  });

  it("getRunProvenance 返回 null 时展示无追溯信息", async () => {
    const run = { id: "run_nullproven001", conversation_id: "c", status: "succeeded",
      trigger_type: "manual_run", execution_mode: "single_agent" };
    mockedList.mockResolvedValueOnce([run]);
    mockedProv.mockResolvedValueOnce(null);
    const client = { baseUrl: "http://test" } as never;
    render(
      <AppProvider>
        <RunsPanel client={client} conversationId="c" refreshSignal={0} />
      </AppProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "追溯" }));
    expect(await screen.findByText(/未绑定专家快照/)).toBeInTheDocument();
  });
});
