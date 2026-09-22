import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Banner } from "@astryxdesign/core/Banner";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { useApp } from "../../lib/app-context";
import { listLoadedExperts, type LoadedExpertProjection } from "../group/useGroupApi";
import { scheduleLabel, type AutomationTask, type Connector, type TaskRun, type TaskSchedule } from "./types";
import "./tasks.css";

const base = "/api/agent/automation-tasks";
const categories = { all: "全部分类", report: "报告", monitor: "监控", reminder: "提醒", other: "其他" };
const statuses: Record<string, string> = { active: "启用中", paused: "已暂停", completed: "已完成", running: "执行中", succeeded: "成功", error: "失败", aborted: "已取消", unknown: "结果待核实", blocked: "已阻塞", queued: "待执行", skipped: "已跳过" };
const at = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN") : "—";
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败，请重试";
const localDate = (iso: string) => { const date = new Date(iso); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
interface Draft { name: string; prompt: string; category: string; employee_id: string; connector_ids: string[]; mode: TaskSchedule["mode"]; timezone: string; time: string; weekday: number; day: number; interval: number; start: string }
const emptyDraft = (): Draft => ({ name: "", prompt: "", category: "other", employee_id: "", connector_ids: [], mode: "daily", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, time: "09:00", weekday: 1, day: 1, interval: 60, start: localDate(new Date(Date.now() + 3_600_000).toISOString()) });
function draftFor(task: AutomationTask): Draft {
  const rule = task.schedule;
  return { ...emptyDraft(), name: task.name, prompt: task.prompt ?? "", category: task.category, employee_id: task.employee_id ?? "", connector_ids: task.connector_ids, ...(rule ? { mode: rule.mode, timezone: rule.timezone } : {}),
    ...(rule && "time" in rule ? { time: rule.time } : {}), ...(rule?.mode === "weekly" ? { weekday: rule.weekday } : {}), ...(rule?.mode === "monthly" ? { day: rule.day_of_month } : {}),
    ...(rule?.mode === "interval" ? { interval: rule.interval_seconds / 60, start: localDate(rule.starts_at) } : {}), ...(rule?.mode === "once" ? { start: localDate(rule.run_at) } : {}) };
}
export function draftSchedule(draft: Draft): TaskSchedule {
  const common = { timezone: draft.timezone };
  if (draft.mode === "once") return { ...common, mode: "once", run_at: new Date(draft.start).toISOString() };
  if (draft.mode === "interval") return { ...common, mode: "interval", starts_at: new Date(draft.start).toISOString(), interval_seconds: draft.interval * 60 };
  const time = draft.time.length === 5 ? `${draft.time}:00` : draft.time;
  if (draft.mode === "weekly") return { ...common, mode: "weekly", time, weekday: draft.weekday };
  if (draft.mode === "monthly") return { ...common, mode: "monthly", time, day_of_month: draft.day, invalid_date_policy: "skip" };
  return { ...common, mode: "daily", time };
}
export function TasksPage() {
  const { client } = useApp();
  const [searchParams] = useSearchParams();
  const [tasks, setTasks] = useState<AutomationTask[]>([]), [experts, setExperts] = useState<LoadedExpertProjection[]>([]);
  const [selected, setSelected] = useState<AutomationTask | null>(null), [editing, setEditing] = useState(false), [draft, setDraft] = useState(emptyDraft);
  const [connectors, setConnectors] = useState<Connector[]>([]), [runs, setRuns] = useState<TaskRun[]>([]), [runCursor, setRunCursor] = useState<string | null>(null);
  const [category, setCategory] = useState("all"), [status, setStatus] = useState("all"), [q, setQ] = useState("");
  const [cursor, setCursor] = useState<string | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const creation = useRef({ key: crypto.randomUUID(), fingerprint: "" });
  const generation = useRef(0), requested = useRef(false);
  const load = useCallback(async (after?: string) => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await client.listGet<AutomationTask>(base, { query: { category, status, q, cursor: after } });
      if (current !== generation.current) return;
      setTasks(previous => after ? [...previous, ...result.items] : result.items); setCursor(result.page.next_cursor); setError(null);
    } catch (e) { if (current === generation.current) setError(errorText(e)); }
    finally { if (current === generation.current) setLoading(false); }
  }, [client, category, status, q]);
  useEffect(() => { const timeout = setTimeout(() => void load(), 200); return () => clearTimeout(timeout); }, [load]);
  useEffect(() => { void listLoadedExperts(client).then(setExperts).catch(e => setError(errorText(e))); }, [client]);
  useEffect(() => {
    let cancelled = false;
    setConnectors([]);
    if (editing && draft.employee_id) void client.listGet<Connector>("/api/agent/connectors", { query: { employee_id: draft.employee_id } }).then(result => { if (!cancelled) setConnectors(result.items); }).catch(e => { if (!cancelled) setError(errorText(e)); });
    return () => { cancelled = true; };
  }, [client, editing, draft.employee_id]);
  async function open(task: AutomationTask) {
    setBusy(true); setError(null); setEditing(false); setDeleting(false);
    try {
      const detail = await client.get<AutomationTask>(`${base}/${encodeURIComponent(task.task_id)}`);
      const history = await client.listGet<TaskRun>(`${base}/${encodeURIComponent(task.task_id)}/runs`);
      setSelected(detail); setRuns(history.items); setRunCursor(history.page.next_cursor);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  useEffect(() => {
    const conversationId = searchParams.get("conversation_id");
    const target = tasks.find(t => t.conversation_id === conversationId);
    if (target && !requested.current) { requested.current = true; void open(target); }
  }, [tasks, searchParams]);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const initial = selected ? draftFor(selected) : null;
      const scheduleChanged = !initial || ["mode", "timezone", "time", "weekday", "day", "interval", "start"].some(key => draft[key as keyof Draft] !== initial[key as keyof Draft]);
      const body = {
        ...(!initial || draft.name !== initial.name ? { name: draft.name } : {}),
        ...(!initial || draft.prompt !== initial.prompt ? { prompt: draft.prompt } : {}),
        ...(!initial || draft.category !== initial.category ? { category: draft.category } : {}),
        ...(selected?.target_kind !== "group" && (!initial || draft.employee_id !== initial.employee_id) ? { employee_id: draft.employee_id } : {}),
        ...(selected?.target_kind !== "group" && (!initial || JSON.stringify(draft.connector_ids) !== JSON.stringify(initial.connector_ids)) ? { connector_ids: draft.connector_ids } : {}),
        ...(scheduleChanged || !selected?.schedule ? { schedule: draftSchedule(draft) } : {}),
      };
      const fingerprint = JSON.stringify(body);
      if (creation.current.fingerprint !== fingerprint) creation.current = { fingerprint, key: crypto.randomUUID() };
      const saved = selected ? await client.patch<AutomationTask>(`${base}/${selected.task_id}`, { body, headers: { "If-Match": selected.etag } }) : await client.post<AutomationTask>(base, { body, idempotencyKey: creation.current.key });
      setEditing(false); setSelected(saved); await load();
      if (saved) await open(saved);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function action(action: "enable" | "pause" | "delete") {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const options = { headers: { "If-Match": selected.etag } };
      if (action === "delete") { await client.del(`${base}/${selected.task_id}`, options); setSelected(null); }
      else setSelected(await client.post<AutomationTask>(`${base}/${selected.task_id}/actions/${action}`, options));
      setDeleting(false); await load();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function moreRuns() {
    if (!selected || !runCursor) return;
    setBusy(true);
    try { const result = await client.listGet<TaskRun>(`${base}/${selected.task_id}/runs`, { query: { cursor: runCursor } }); setRuns(previous => [...previous, ...result.items]); setRunCursor(result.page.next_cursor); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  return <VStack gap={4}>
    <HStack gap={3} wrap="wrap"><Heading level={1}>自动化任务</Heading><Button onClick={() => { setSelected(null); setDraft(emptyDraft()); setEditing(true); setError(null); }} label="新建任务" /><Button variant="secondary" onClick={() => void load()} isDisabled={loading} label="刷新" /></HStack>
    <Text type="supporting">任务在本机运行，需要 Agent 保持运行且登录有效。同一任务复用会话上下文；外部操作可能需要审批。</Text>
    {error && <Banner status="error" title={error} />}
    <div className={"automation-filters"}><label>搜索<input type="search" value={q} maxLength={120} onChange={e => setQ(e.target.value)} placeholder="任务、指令或员工" /></label><label>分类<select value={category} onChange={e => setCategory(e.target.value)}>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>状态<select value={status} onChange={e => setStatus(e.target.value)}><option value="all">全部状态</option>{["active", "paused", "completed"].map(s => <option key={s} value={s}>{statuses[s]}</option>)}</select></label></div>
    <div className={"automation-layout"}><section aria-label="任务列表" aria-busy={loading} className={"automation-list"}>
      {!tasks.length && <Text>{loading ? "正在加载…" : "暂无任务，创建一个定时工作安排。"}</Text>}
      {tasks.map(task => <Card key={task.task_id}><VStack gap={2}><Button variant="secondary" onClick={() => void open(task)} isDisabled={busy} label={task.name} /><Text>{task.employee?.display_name ?? (task.target_kind === "group" ? "群聊" : "员工不可用")} · {statuses[task.status]}</Text><Text type="supporting">{scheduleLabel(task.schedule)}</Text><Text>{task.prompt_summary}</Text><Text type="supporting">下次：{at(task.next_run_at)}</Text>{task.last_run && <Text>上次结果：{statuses[task.last_run.status] ?? task.last_run.status}</Text>}</VStack></Card>)}
      {cursor && <Button variant="secondary" onClick={() => void load(cursor)} isDisabled={loading} label="加载更多任务" />}
    </section>
    <section aria-label={editing ? "任务编辑" : "任务详情"} className={"automation-detail"}>
      {editing ? <Card><form className={"automation-form"} onSubmit={save}>
        <Heading level={2}>{selected ? "编辑任务" : "新建任务"}</Heading>
        <label>名称<input required maxLength={120} value={draft.name} onChange={e => set("name", e.target.value)} /></label>
        <label>执行指令<textarea required rows={5} maxLength={20_000} value={draft.prompt} onChange={e => set("prompt", e.target.value)} /></label>
        <label>任务分类<select value={draft.category} onChange={e => set("category", e.target.value)}>{Object.entries(categories).filter(([key]) => key !== "all").map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        {selected?.target_kind !== "group" && <><label>执行员工<select required value={draft.employee_id} onChange={e => setDraft(previous => ({ ...previous, employee_id: e.target.value, connector_ids: [] }))}><option value="">请选择员工</option>{experts.filter(e => !e.revoked).map(e => <option key={e.employee_id} value={e.employee_id}>{e.display_name}</option>)}</select></label>
        <fieldset><legend>使用的连接器</legend>{!connectors.length && <p>该员工暂无已授权且本机已安装的连接器，可不选择继续创建。</p>}{connectors.map(c => <label className={"automation-checkbox"} key={c.connector_id}><input type="checkbox" disabled={c.status !== "enabled"} checked={draft.connector_ids.includes(c.connector_id)} onChange={e => set("connector_ids", e.target.checked ? [...draft.connector_ids, c.connector_id] : draft.connector_ids.filter(id => id !== c.connector_id))} />{c.display_name}{c.status !== "enabled" && "（未就绪）"}</label>)}{draft.connector_ids.filter(id => !connectors.some(c => c.connector_id === id)).map(id => <label key={id} className={"automation-checkbox"}><input type="checkbox" checked onChange={() => set("connector_ids", draft.connector_ids.filter(c => c !== id))} />{id}（当前不可用，可取消选择）</label>)}</fieldset></>}
        <label>执行频率<select value={draft.mode} onChange={e => set("mode", e.target.value as Draft["mode"])}>{Object.entries({ daily: "每天", weekly: "每周", monthly: "每月", interval: "固定间隔", once: "单次" }).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>时区<input required value={draft.timezone} onChange={e => set("timezone", e.target.value)} placeholder="Asia/Shanghai" /></label>
        {["daily", "weekly", "monthly"].includes(draft.mode) && <label>当地执行时间<input type="time" required step="1" value={draft.time} onChange={e => set("time", e.target.value)} /></label>}
        {draft.mode === "weekly" && <label>星期<select value={draft.weekday} onChange={e => set("weekday", Number(e.target.value))}>{Array.from("一二三四五六日").map((day, i) => <option key={day} value={i + 1}>周{day}</option>)}</select></label>}
        {draft.mode === "monthly" && <label>每月日期<input type="number" required min={1} max={31} value={draft.day} onChange={e => set("day", Number(e.target.value))} /><small>没有该日期的月份跳过。</small></label>}
        {["interval", "once"].includes(draft.mode) && <label>{draft.mode === "once" ? "执行时间" : "起始时间"}（按当前电脑时区输入）<input type="datetime-local" required value={draft.start} onChange={e => set("start", e.target.value)} /></label>}
        {draft.mode === "interval" && <label>间隔分钟<input type="number" min={5} required value={draft.interval} onChange={e => set("interval", Number(e.target.value))} /></label>}
        <HStack gap={2}><Button type="submit" isDisabled={busy} label={busy ? "保存中…" : "保存任务"} /><Button variant="secondary" onClick={() => setEditing(false)} isDisabled={busy} label="取消" /></HStack>
      </form></Card> : selected ? <Card><VStack gap={3}>
        <Heading level={2}>{selected.name}</Heading><Text>{selected.prompt}</Text><Text>{scheduleLabel(selected.schedule)}</Text><Text>状态：{statuses[selected.status]} · 下次：{at(selected.next_run_at)}</Text>
        {selected.block_reason && <Banner status="warning" title={selected.block_reason === "authorization_required" ? "需要有效登录才能执行" : selected.block_reason === "configuration_required" ? "请重新配置执行计划" : "当前执行条件未满足，请查看运行记录"} />}
        <HStack gap={2} wrap="wrap"><Button onClick={() => { setDraft(draftFor(selected)); setEditing(true); }} label="编辑" /><Button variant="secondary" isDisabled={busy || selected.status === "completed" || !selected.schedule} onClick={() => void action(selected.status === "active" ? "pause" : "enable")} label={selected.status === "active" ? "暂停" : "启用"} /><Button variant="secondary" isDisabled={busy} onClick={() => setDeleting(true)} label="删除任务" />{selected.conversation_id && <Link to={`/${selected.target_kind === "group" ? "group" : "chat"}?conversation_id=${encodeURIComponent(selected.conversation_id)}`}>打开会话与审批</Link>}</HStack>
        {deleting && <div role="alert"><p>停止后续调度并删除任务？已有会话和执行记录会保留。</p><Button isDisabled={busy} onClick={() => void action("delete")} label="确认删除" /><Button variant="secondary" onClick={() => setDeleting(false)} label="取消" /></div>}
        <HStack gap={2}><Heading level={3}>运行记录</Heading><Button variant="secondary" onClick={() => void open(selected)} isDisabled={busy} label="刷新记录" /></HStack>
        {!runs.length && <Text type="supporting">暂无关联的运行记录。旧会话中未建立调度关联的历史仍可在会话内查看。</Text>}
        {runs.map(run => <article className={"automation-run"} key={run.run_id}><strong>{statuses[run.status] ?? run.status}</strong><p>计划：{at(run.scheduled_at)} · 开始：{at(run.started_at)}</p>{run.result_summary && <p>{run.result_summary}</p>}{run.error_code && <p>{run.error_code}</p>}{run.error_code !== "conversation_deleted" && <Link to={`/${selected.target_kind === "group" ? "group" : "chat"}?conversation_id=${encodeURIComponent(run.conversation_id)}`}>查看本次执行所在会话</Link>}</article>)}
        {runCursor && <Button variant="secondary" onClick={() => void moreRuns()} isDisabled={busy} label="更多运行记录" />}
      </VStack></Card> : <Text type="supporting">选择任务查看详情与运行记录。</Text>}
    </section></div>
  </VStack>;
}
