export interface OfficeEmployee { employee_id: string; display_name: string; status: string; task: string | null; avatar_url: string | null; }
export interface OfficeScene { employees: OfficeEmployee[]; summary: Record<string, number>; }
export type ScheduledJobStatus = "active" | "paused" | "completed" | "error";
export type RecurrenceType = "once" | "daily" | "weekly" | "monthly" | "cron";
export interface OfficeScheduledJob {
  type: "scheduled_job";
  loop_id: string;
  title: string;
  status: ScheduledJobStatus;
  conversation_id: string;
  recurrence_type: RecurrenceType;
  cron: string;
  next_run_at: string | null;
  fire_count: number;
  last_fired_at: string | null;
  max_retries: number;
  retry_count: number;
  created_at: string;
}
export interface OfficeFeed { events: OfficeScheduledJob[]; }
