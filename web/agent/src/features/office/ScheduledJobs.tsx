/**
 * 用户端工作台办公室聚合 scheduled jobs 卡片（issue #418）。
 *
 * 本地优先：数据全部来自本地 Loop 仓储，不依赖远端推送。
 * 展示态不落库——仅渲染 Loop 主状态（status / next_run_at / fire_count），
 * run 终态走 RunsPanel / timeline。
 */

import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { OfficeScheduledJob, ScheduledJobStatus } from "./types";

const STATUS_LABEL: Record<ScheduledJobStatus, string> = {
  active: "运行中",
  paused: "已暂停",
  completed: "已完成",
  error: "错误",
};
const STATUS_ICON: Record<ScheduledJobStatus, string> = { active: "⚡", paused: "⏸", completed: "✓", error: "⚠" };

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
    <Card key={job.loop_id} data-testid="office-scheduled-job" padding={3} width={280}>
      <VStack gap={1}>
      <HStack justify="between"><Text weight="semibold">{job.title}</Text><Badge label={`${STATUS_ICON[job.status]} ${STATUS_LABEL[job.status]}`} variant={job.status === "error" ? "error" : job.status === "active" ? "success" : "neutral"} /></HStack>
      <Text type="supporting">重复：{recurrenceSuffix(job)}</Text>
      {job.next_run_at && (
        <Text type="supporting">下次触发：{formatTimestamp(job.next_run_at)}</Text>
      )}
      <Text type="supporting">
        已触发 {job.fire_count} 次 · 上次：{formatTimestamp(job.last_fired_at)}
      </Text>
      {job.retry_count > 0 && (
        <Text type="supporting">
          连续失败 {job.retry_count}/{job.max_retries}
        </Text>
      )}
      </VStack>
    </Card>
  );
}

interface ScheduledJobsProps {
  jobs: OfficeScheduledJob[];
}

export function ScheduledJobs({ jobs }: ScheduledJobsProps) {
  if (jobs.length === 0) {
    return <EmptyState title="暂无定时任务" data-testid="office-scheduled-jobs-empty" />;
  }
  return (
    <HStack gap={3} wrap="wrap" data-testid="office-scheduled-jobs">
      {jobs.map((job) => (
        <JobCard key={job.loop_id} job={job} />
      ))}
    </HStack>
  );
}
