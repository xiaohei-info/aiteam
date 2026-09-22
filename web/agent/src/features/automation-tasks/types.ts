export type TaskSchedule =
  | { mode: "daily"; timezone: string; time: string }
  | { mode: "weekly"; timezone: string; time: string; weekday: number }
  | { mode: "monthly"; timezone: string; time: string; day_of_month: number; invalid_date_policy: "skip" }
  | { mode: "once"; timezone: string; run_at: string }
  | { mode: "interval"; timezone: string; starts_at: string; interval_seconds: number };
export interface Connector { connector_id: string; display_name: string; status: "enabled" | "unavailable"; available_employee_ids: string[] }
export interface TaskRun { run_id: string; conversation_id: string; scheduled_at: string; started_at: string | null; finished_at: string | null; status: string; error_code: string | null; result_summary: string | null }
export interface AutomationTask {
  task_id: string; name: string; category: string; prompt?: string; prompt_summary: string;
  employee_id: string | null; employee: { display_name: string } | null; connector_ids: string[];
  schedule: TaskSchedule | null; status: string; etag: string; target_kind: "private" | "group";
  conversation_id: string | null; block_reason: string | null; next_run_at: string | null; last_run: TaskRun | null;
}
export function scheduleLabel(rule: TaskSchedule | null): string {
  if (!rule) return "尚未配置";
  if (rule.mode === "once") return `单次 · ${new Date(rule.run_at).toLocaleString()}`;
  if (rule.mode === "interval") return `每 ${rule.interval_seconds / 60} 分钟`;
  const prefix = rule.mode === "daily" ? "每天" : rule.mode === "weekly" ? `每周${"一二三四五六日"[rule.weekday - 1]}` : `每月 ${rule.day_of_month} 日`;
  return `${prefix} ${rule.time} · ${rule.timezone}`;
}
