import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TasksPage } from "./TasksPage";
import { AgentApiClient } from "../../lib/api-client";
import type { AutomationTask } from "./types";
let client: AgentApiClient;
vi.mock("../../lib/app-context", () => ({ useApp: () => ({ client }) }));
const task: AutomationTask = { task_id: "t1", name: "每日简报", prompt: "汇总进度", prompt_summary: "汇总进度", category: "report", employee_id: "e1", employee: { display_name: "研究员" }, connector_ids: [], schedule: { mode: "daily", timezone: "Asia/Shanghai", time: "09:00:00" }, status: "active", etag: '"1-1"', target_kind: "private", conversation_id: "c1", block_reason: null, next_run_at: null, last_run: null };
function setup(fail = false) {
  const requests: { path: string; init?: RequestInit }[] = [];
  client = new AgentApiClient({ baseUrl: "http://test", fetch: vi.fn(async (url, init) => {
    const path = String(url); requests.push({ path, init });
    if (fail && path.includes("automation-tasks")) return new Response(JSON.stringify({ type: "about:blank", title: "Unavailable", status: 503, code: "unavailable", detail: "服务不可用", instance: "/tasks", request_id: "test" }), { status: 503, headers: { "content-type": "application/problem+json" } });
    const data = path.includes("grants/experts") ? [{ employee_id: "e1", display_name: "研究员", revoked: false }] : path.includes("connectors") || path.includes("/runs") ? [] : path.endsWith("/t1") || init?.method === "POST" ? task : [task];
    return new Response(JSON.stringify({ data, page: { next_cursor: null, has_more: false } }), { headers: { "content-type": "application/json" } });
  }) });
  render(<MemoryRouter><TasksPage /></MemoryRouter>);
  return requests;
}
afterEach(() => vi.restoreAllMocks());
describe("automation task integration", () => {
  it("lists real tasks, edits only changed fields with If-Match and links the existing conversation", async () => {
    const requests = setup();
    fireEvent.click(await screen.findByRole("button", { name: "每日简报" }));
    const edit = await screen.findByRole("button", { name: "编辑" });
    expect(screen.getByRole("link", { name: "打开会话与审批" }).getAttribute("href")).toBe("/chat?conversation_id=c1");
    fireEvent.click(edit);
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "更新简报" } });
    fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
    await waitFor(() => expect(requests.some(r => r.init?.method === "PATCH")).toBe(true));
    const request = requests.find(r => r.init?.method === "PATCH")!;
    expect(JSON.parse(String(request.init?.body))).toEqual({ name: "更新简报" });
    expect(new Headers(request.init?.headers).get("If-Match")).toBe('"1-1"');
  });
  it("creates calendar tasks using an idempotency key and current employee", async () => {
    const requests = setup();
    await screen.findByRole("button", { name: "每日简报" });
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "每月总结" } });
    fireEvent.change(screen.getByLabelText("执行指令"), { target: { value: "总结" } });
    fireEvent.change(screen.getByLabelText("执行员工"), { target: { value: "e1" } });
    fireEvent.change(screen.getByLabelText("执行频率"), { target: { value: "monthly" } });
    fireEvent.change(screen.getByLabelText(/^每月日期/), { target: { value: "31" } });
    fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
    await waitFor(() => expect(requests.some(r => r.init?.method === "POST")).toBe(true));
    const request = requests.find(r => r.init?.method === "POST")!;
    expect(JSON.parse(String(request.init?.body))).toMatchObject({ employee_id: "e1", connector_ids: [], schedule: { mode: "monthly", day_of_month: 31, invalid_date_policy: "skip" } });
    expect(new Headers(request.init?.headers).get("Idempotency-Key")).toBeTruthy();
  });
  it("shows backend errors without demo fallback tasks", async () => {
    setup(true);
    expect(await screen.findByText("服务不可用")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "每日简报" })).toBeNull();
  });
});
