import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TasksPage, draftSchedule } from "./TasksPage";
import { AgentApiClient } from "../../lib/api-client";
import { scheduleLabel, type AutomationTask } from "./types";
let client: AgentApiClient;
vi.mock("../../lib/app-context", () => ({ useApp: () => ({ client }) }));
const task: AutomationTask = { task_id: "t1", name: "每日简报", prompt: "汇总进度", prompt_summary: "汇总进度", category: "report", employee_id: "e1", employee: { display_name: "研究员" }, connector_ids: [], schedule: { mode: "daily", timezone: "Asia/Shanghai", time: "09:00:00" }, status: "active", etag: '"1-1"', target_kind: "private", conversation_id: "c1", block_reason: null, next_run_at: null, last_run: null };
function setup(fail = false, override?: (path: string, init?: RequestInit) => Response | undefined) {
  const requests: { path: string; init?: RequestInit }[] = [];
  client = new AgentApiClient({ baseUrl: "http://test", fetch: vi.fn(async (url, init) => {
    const path = String(url); requests.push({ path, init });
    const overridden = override?.(path, init); if (overridden) return overridden;
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

const response = (data: unknown, cursor: string | null = null) => new Response(JSON.stringify({ data, page: { next_cursor: cursor, has_more: !!cursor } }), { headers: { "content-type": "application/json" } });
const problem = () => new Response(JSON.stringify({ type: "about:blank", title: "Conflict", status: 409, code: "task_revision_conflict", detail: "请刷新任务", instance: "/tasks", request_id: "test" }), { status: 409, headers: { "content-type": "application/problem+json" } });
it("paginates task and run lists, filters employees, and pauses/enables/deletes through the shared task", async () => {
  let deleted = false;
  const requests = setup(false, (path, init) => {
    if (path.includes("/actions/pause")) return response({ ...task, status: "paused", etag: '\"2-2\"' });
    if (path.includes("/actions/enable")) return response(task);
    if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
    if (path.includes("/runs")) return response([{ run_id: path.includes("cursor") ? "r2" : "r1", conversation_id: "c1", scheduled_at: "2026-09-22T00:00:00Z", started_at: null, finished_at: null, status: "unknown", error_code: "execution_unknown", result_summary: "本次结果待确认" }], path.includes("cursor") ? null : "runs-next");
    if (path.includes("automation-tasks?") || path.endsWith("automation-tasks")) return response(deleted ? [] : [{ ...task, task_id: path.includes("cursor") ? "t2" : "t1", name: path.includes("cursor") ? "第二条" : task.name }], !deleted && !path.includes("cursor") ? "tasks-next" : null);
  });
  fireEvent.click(await screen.findByRole("button", { name: "加载更多任务" }));
  await screen.findByRole("button", { name: "第二条" });
  fireEvent.change(screen.getByLabelText("筛选员工"), { target: { value: "e1" } });
  fireEvent.change(screen.getByLabelText("分类", { exact: true }), { target: { value: "report" } });
  fireEvent.change(screen.getByLabelText("状态", { exact: true }), { target: { value: "active" } });
  fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "简报" } });
  await waitFor(() => expect(requests.some(r => r.path.includes("employee_id=e1") && r.path.includes("category=report"))).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "每日简报" }));
  fireEvent.click(await screen.findByRole("button", { name: "更多运行记录" }));
  await waitFor(() => expect(screen.getAllByText("本次结果待确认")).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  fireEvent.click(await screen.findByRole("button", { name: "启用" }));
  await screen.findByRole("button", { name: "暂停" });
  fireEvent.click(screen.getByRole("button", { name: "删除任务" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(requests.some(r => r.init?.method === "DELETE")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "删除任务" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "每日简报" })).toBeNull());
});
it("a failed create preserves both the form and idempotency key for retry", async () => {
  let attempts = 0;
  const requests = setup(false, (_path, init) => init?.method === "POST" && ++attempts === 1 ? problem() : undefined);
  await screen.findByRole("button", { name: "每日简报" });
  fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "定时提醒" } });
  fireEvent.change(screen.getByLabelText("执行指令"), { target: { value: "提醒我" } });
  fireEvent.change(screen.getByLabelText("执行员工"), { target: { value: "e1" } });
  fireEvent.change(screen.getByLabelText("执行频率"), { target: { value: "once" } });
  fireEvent.change(screen.getByLabelText(/^执行时间/), { target: { value: "2027-01-01T09:30" } });
  fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
  await screen.findByText("请刷新任务");
  expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("定时提醒");
  fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
  await waitFor(() => expect(requests.filter(r => r.init?.method === "POST")).toHaveLength(2));
  const writes = requests.filter(r => r.init?.method === "POST");
  expect(new Headers(writes[0]!.init?.headers).get("Idempotency-Key")).toBe(new Headers(writes[1]!.init?.headers).get("Idempotency-Key"));
});
it.each([
  { mode: "weekly", timezone: "Asia/Shanghai", time: "10:30:00", weekday: 2 },
  { mode: "monthly", timezone: "UTC", time: "09:00:00", day_of_month: 31, invalid_date_policy: "skip" },
  { mode: "interval", timezone: "UTC", interval_seconds: 600, starts_at: "2027-01-01T00:00:00Z" },
  { mode: "once", timezone: "UTC", run_at: "2027-01-01T00:00:00Z" },
] as const)("existing $mode task loads its exact rule without overwriting it on metadata edits", async schedule => {
  setup(false, path => path.endsWith("/t1") ? response({ ...task, schedule }) : undefined);
  fireEvent.click(await screen.findByRole("button", { name: "每日简报" }));
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  expect((screen.getByLabelText("执行频率") as HTMLSelectElement).value).toBe(schedule.mode);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
});
it("calendar labels and instant conversion honor selected timezone and reject a DST gap", () => {
  const draft = { name: "x", prompt: "x", category: "other", employee_id: "e1", connector_ids: [], mode: "once" as const, timezone: "Asia/Shanghai", time: "09:00", weekday: 1, day: 31, interval: 60, start: "2027-01-01T09:00" };
  expect(draftSchedule(draft)).toMatchObject({ run_at: "2027-01-01T01:00:00Z" });
  expect(draftSchedule({ ...draft, mode: "interval" })).toMatchObject({ interval_seconds: 3600, starts_at: "2027-01-01T01:00:00Z" });
  expect(draftSchedule({ ...draft, mode: "weekly" })).toMatchObject({ weekday: 1, time: "09:00:00" });
  expect(() => draftSchedule({ ...draft, timezone: "America/New_York", start: "2026-03-08T02:30" })).toThrow(/不存在/);
  expect(scheduleLabel(null)).toBe("尚未配置");
  expect(scheduleLabel({ mode: "weekly", timezone: "UTC", time: "09:00:00", weekday: 1 })).toContain("每周一");
  expect(scheduleLabel({ mode: "monthly", timezone: "UTC", time: "09:00:00", day_of_month: 31, invalid_date_policy: "skip" })).toContain("31 日");
  expect(scheduleLabel({ mode: "interval", timezone: "UTC", starts_at: "2027-01-01T00:00:00Z", interval_seconds: 300 })).toBe("每 5 分钟");
  expect(scheduleLabel({ mode: "once", timezone: "UTC", run_at: "2027-01-01T00:00:00Z" })).toContain("单次");
});
