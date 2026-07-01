/**
 * 用户端工作台办公室聚合 scheduled jobs 卡片（issue #418）。
 *
 * 本地优先：数据全部来自本地 Loop 仓储，不依赖远端推送。
 * 展示态不落库——仅渲染 Loop 主状态（status / next_run_at / fire_count），
 * run 终态走 RunsPanel / timeline。
 */

import { GlassPanel } from "@aiteam/shared/ui";
import type { OfficeScheduledJob, ScheduledJobStatus } from "./types";

const STATUS_LABEL: Record<ScheduledJobStatus, string> = {
  active: "运行中",
  paused: "已暂停",
  completed: "已完成",
  error: "错误",
};
const STATUS_ICON: Record<ScheduledJobStatus, string> = { active: "⚡", paused: "⏸", completed: "✓", error: "⚠" };
const STATUS_COLOR: Record<ScheduledJobStatus, string> = {
  active: "text-success", paused: "text-text-muted", completed: "text-success", error: "text-danger",
};

function formatTimestamp(ts: string | null): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function recurrenceSuffix(job: OfficeScheduledJob): string {
  if (job.recurrence_type === "cron") return job.cron;
  const map: Record<string, string> = { once: "单次", daily: "每天", weekly: "每周", monthly: "每月" };
  return map[job.recurrence_type] ?? job.recurrence_type;
}

interface JobCardProps {
  job: OfficeScheduledJob;
}

function JobCard({ job }: JobCardProps) {
  return (
    <GlassPanel key={job.loop_id} data-testid="office-scheduled-job" className="rounded-window p-md">
      <div className="flex items-start justify-between gap-sm">
        <p className="m-0 text-sm font-bold text-text-primary">{job.title}</p>
        <span className={`text-xs ${STATUS_COLOR[job.status]}`}>{STATUS_ICON[job.status]} {STATUS_LABEL[job.status]}</span>
      </div>
      <p className="m-0 mt-xs text-xs text-text-muted">重复：{recurrenceSuffix(job)}</p>
      {job.next_run_at && (
        <p className="m-0 mt-xs text-xs text-text-muted">下次触发：{formatTimestamp(job.next_run_at)}</p>
      )}
      <p className="m-0 mt-xs text-xs text-text-muted">
        已触发 {job.fire_count} 次 · 上次：{formatTimestamp(job.last_fired_at)}
      </p>
      {job.retry_count > 0 && (
        <p className="m-0 mt-xs text-xs text-danger">
          连续失败 {job.retry_count}/{job.max_retries}
        </p>
      )}
    </GlassPanel>
  );
}

interface ScheduledJobsProps {
  jobs: OfficeScheduledJob[];
}

export function ScheduledJobs({ jobs }: ScheduledJobsProps) {
  if (jobs.length === 0) {
    return <GlassPanel className="rounded-window p-lg text-sm text-text-secondary" data-testid="office-scheduled-jobs-empty">暂无定时任务</GlassPanel>;
  }
  return (
    <div className="grid grid-cols-3 gap-md" data-testid="office-scheduled-jobs">
      {jobs.map((job) => (
        <JobCard key={job.loop_id} job={job} />
      ))}
    </div>
  );
}
