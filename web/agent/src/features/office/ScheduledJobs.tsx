/** Conversation.schedule metadata cards; execution state remains in the Pi event stream. */

import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { ConversationSchedule } from "./types";

interface JobCardProps {
  job: ConversationSchedule;
}

function JobCard({ job }: JobCardProps) {
  return (
    <Card key={job.conversation_id} data-testid="office-scheduled-job" padding={3} width={280}>
      <VStack gap={1}>
        <Text weight="semibold">{job.title}</Text>
        <Text type="supporting">会话：{job.conversation_id}</Text>
        <Text type="supporting">调度：{JSON.stringify(job.schedule)}</Text>
      </VStack>
    </Card>
  );
}

interface ScheduledJobsProps {
  jobs: ConversationSchedule[];
}

export function ScheduledJobs({ jobs }: ScheduledJobsProps) {
  if (jobs.length === 0) {
    return <EmptyState title="暂无定时任务" data-testid="office-scheduled-jobs-empty" />;
  }
  return (
    <HStack gap={3} wrap="wrap" data-testid="office-scheduled-jobs">
      {jobs.map((job) => (
        <JobCard key={job.conversation_id} job={job} />
      ))}
    </HStack>
  );
}
