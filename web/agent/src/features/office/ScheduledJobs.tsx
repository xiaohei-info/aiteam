/** Conversation.schedule metadata cards; execution state remains in the Pi event stream. */

import { EmptyState } from "@astryxdesign/core/EmptyState";
import type { ConversationSchedule } from "./types";

function formatSchedule(schedule: Record<string, unknown> | null): string {
  if (!schedule) return "未配置";
  if (schedule.one_shot === true) return schedule.at ? `单次 · ${String(schedule.at)}` : "单次";
  if (typeof schedule.interval_seconds === "number") return `每 ${schedule.interval_seconds} 秒`;
  if (typeof schedule.at === "string" && schedule.at) return `从 ${schedule.at} 开始`;
  if (schedule.enabled === false) return "已暂停";
  return "按配置执行";
}

interface JobCardProps {
  job: ConversationSchedule;
}

function JobCard({ job }: JobCardProps) {
  return (
    <article className={"office-job-card"} data-testid="office-scheduled-job">
      <span className={"office-job-card__tag"}>SCHEDULED</span>
      <strong className={"office-job-card__title"}>{job.title}</strong>
      <div className={"office-job-card__meta"}>
        <span>会话：{job.conversation_id}</span>
        <span>调度：{formatSchedule(job.schedule)}</span>
      </div>
    </article>
  );
}

interface ScheduledJobsProps {
  jobs: ConversationSchedule[];
}

export function ScheduledJobs({ jobs }: ScheduledJobsProps) {
  if (jobs.length === 0) {
    return <EmptyState title="暂无定时任务" data-testid="office-scheduled-jobs-empty" headingLevel={3} isCompact />;
  }
  return (
    <div className={"office-job-list"} data-testid="office-scheduled-jobs" role="list" aria-label="定时任务列表">
      {jobs.map((job) => (
        <div key={job.conversation_id} role="listitem">
          <JobCard job={job} />
        </div>
      ))}
    </div>
  );
}
