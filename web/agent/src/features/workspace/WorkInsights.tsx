import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { AgentApiClient } from "../../lib/api-client";
import {
  getUsageStatistics,
  listWorkRecordChanges,
  listWorkRecords,
  type UsageStatistics,
  type WorkRecord,
  type WorkRecordChange,
} from "./useWorkspaceApi";

export const WORK_HISTORY_POLL_INTERVAL_MS = 15_000;

export interface WorkInsightsProps {
  client: AgentApiClient;
}

/** Actual local work observations and hourly usage; no client-side estimates. */
export function WorkInsights({ client }: WorkInsightsProps): ReactNode {
  const [records, setRecords] = useState<WorkRecord[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [changeCursor, setChangeCursor] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageStatistics | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [usageLoading, setUsageLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const pollingRef = useRef(false);

  const loadInitial = useCallback(async () => {
    setHistoryLoading(true);
    setUsageLoading(true);
    setHistoryError(null);
    setUsageError(null);
    const [historyResult, usageResult] = await Promise.allSettled([
      listWorkRecords(client, { limit: 20 }),
      getUsageStatistics(client),
    ]);
    if (historyResult.status === "fulfilled") {
      setRecords(historyResult.value.items);
      setHistoryCursor(historyResult.value.nextCursor);
      setChangeCursor(historyResult.value.after || null);
      setHistoryLoaded(true);
    } else {
      setHistoryError(displayError(historyResult.reason, "工作历史暂不可用"));
    }
    if (usageResult.status === "fulfilled") {
      setUsage(usageResult.value);
    } else {
      setUsageError(displayError(usageResult.reason, "用量统计暂不可用"));
    }
    setHistoryLoading(false);
    setUsageLoading(false);
  }, [client]);

  useEffect(() => { void loadInitial(); }, [loadInitial]);

  const pollChanges = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    const changesTask = changeCursor
      ? (async () => {
          let after = changeCursor;
          let hasMore = true;
          let rounds = 0;
          while (hasMore && rounds < 4) {
            const page = await listWorkRecordChanges(client, { after, limit: 100 });
            setRecords((current) => applyChanges(current, page.items));
            after = page.nextCursor;
            hasMore = page.hasMore;
            rounds += 1;
          }
          return after;
        })()
      : Promise.resolve<string | null>(null);
    const [changesResult, usageResult] = await Promise.allSettled([
      changesTask,
      getUsageStatistics(client),
    ]);
    if (changesResult.status === "fulfilled" && changesResult.value !== null) {
      setChangeCursor(changesResult.value);
    }
    if (usageResult.status === "fulfilled") {
      setUsage(usageResult.value);
      setUsageError(null);
    } else {
      setUsageError(displayError(usageResult.reason, "用量统计暂不可用"));
    }
    pollingRef.current = false;
  }, [changeCursor, client]);

  useEffect(() => {
    if (!historyLoaded) return undefined;
    const timer = window.setInterval(() => { void pollChanges(); }, WORK_HISTORY_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [historyLoaded, pollChanges]);

  async function loadMoreHistory(): Promise<void> {
    if (!historyCursor || loadingMore) return;
    setLoadingMore(true);
    setHistoryError(null);
    try {
      const page = await listWorkRecords(client, { limit: 20, before: historyCursor });
      setRecords((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setHistoryCursor(page.nextCursor);
    } catch (cause) {
      setHistoryError(displayError(cause, "工作历史加载失败"));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <HStack gap={3} align="start" wrap="wrap" data-testid="workspace-work-insights">
      <Card padding={4} width={520} data-testid="workspace-work-history">
        <VStack gap={3}>
          <HStack justify="between" align="center">
            <VStack gap={1}>
              <Heading level={2}>工作历史</Heading>
              <Text type="supporting">来自本机实际 prompt 观察；不会把消息数量当作执行次数。</Text>
            </VStack>
            <Text type="supporting">{historyLoaded ? records.length : "—"}</Text>
          </HStack>
          {historyError ? <Banner status="error" title={historyError} /> : null}
          {historyLoading ? <Text role="status" type="supporting">加载工作历史…</Text> : null}
          {!historyLoading && !historyError && records.length === 0 ? <EmptyState title="暂无工作记录" headingLevel={3} isCompact /> : null}
          {!historyLoading && !historyError && records.length > 0 ? (
            <VStack as="ul" gap={2} data-testid="work-history-list">
              {records.map((record) => <WorkRecordRow key={record.id} record={record} />)}
            </VStack>
          ) : null}
          {historyCursor ? <Button label="加载更早记录" variant="ghost" onClick={() => void loadMoreHistory()} isLoading={loadingMore} isDisabled={loadingMore} /> : null}
        </VStack>
      </Card>
      <Card padding={4} width={360} data-testid="workspace-usage-statistics">
        <VStack gap={3}>
          <VStack gap={1}>
            <Heading level={2}>用量统计</Heading>
            <Text type="supporting">本认证成员、本机已记录的 UTC 小时摘要。</Text>
          </VStack>
          {usageError ? <Banner status="error" title={usageError} /> : null}
          {usageLoading ? <Text role="status" type="supporting">加载用量统计…</Text> : null}
          {!usageLoading && !usageError && !usage ? <EmptyState title="用量统计暂不可用" headingLevel={3} isCompact /> : null}
          {usage ? <UsageSummary usage={usage} /> : null}
        </VStack>
      </Card>
    </HStack>
  );
}

function WorkRecordRow({ record }: { record: WorkRecord }): ReactNode {
  return (
    <li data-testid="work-history-record">
      <HStack justify="between" align="start" gap={2}>
        <VStack gap={1}>
          <Text weight="semibold">{record.employee_display_name || record.employee_id}</Text>
          <Text type="supporting">{record.conversation_title || "未命名会话"} · {workOutcomeLabel(record.outcome)}</Text>
          {record.task_summary ? <Text>{record.task_summary}</Text> : null}
          {record.result_summary ? <Text type="supporting">结果：{record.result_summary}</Text> : null}
        </VStack>
        <Text type="supporting">{formatDate(record.occurred_at)}</Text>
      </HStack>
    </li>
  );
}

function UsageSummary({ usage }: { usage: UsageStatistics }): ReactNode {
  const cost = usage.cost_total === null ? "费用未知" : `USD ${usage.cost_total}`;
  return (
    <dl data-testid="usage-statistics-summary">
      <div><dt>执行次数</dt><dd>{usage.execution_count}</dd></div>
      <div><dt>成功次数</dt><dd>{usage.succeeded_count}</dd></div>
      <div><dt>非成功次数</dt><dd>{usage.non_success_count}</dd></div>
      <div><dt>Token 总量</dt><dd>{usage.token_total}</dd></div>
      <div><dt>总耗时</dt><dd>{formatDuration(usage.duration_ms_total)}</dd></div>
      <div><dt>费用</dt><dd>{cost}</dd></div>
      {usage.cost_total === null ? <div><dt>已知费用小计</dt><dd>USD {usage.known_cost_total}</dd></div> : null}
      <div><dt>计价状态</dt><dd>{pricingLabel(usage.pricing_status)}</dd></div>
      {usage.unpriced_execution_count > 0 ? <div><dt>未计价执行</dt><dd>{usage.unpriced_execution_count}</dd></div> : null}
      {usage.excluded_summary_count > 0 ? <div><dt>排除摘要</dt><dd>{usage.excluded_summary_count}</dd></div> : null}
    </dl>
  );
}

function applyChanges(current: WorkRecord[], changes: WorkRecordChange[]): WorkRecord[] {
  const next = new Map(current.map((record) => [record.id, record] as const));
  for (const change of changes) {
    if (change.operation === "delete") next.delete(change.record_id);
    else next.set(change.record_id, change.record);
  }
  return [...next.values()].sort((left, right) => compareDate(right.occurred_at, left.occurred_at));
}

function compareDate(left: string | null, right: string | null): number {
  const leftTime = left ? Date.parse(left) : Number.NEGATIVE_INFINITY;
  const rightTime = right ? Date.parse(right) : Number.NEGATIVE_INFINITY;
  return (Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY)
    - (Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY);
}

function workOutcomeLabel(outcome: WorkRecord["outcome"]): string {
  if (outcome === "active") return "进行中";
  if (outcome === "succeeded") return "已完成";
  if (outcome === "aborted") return "已中止";
  if (outcome === "error") return "异常";
  return "结果未知";
}

function pricingLabel(status: UsageStatistics["pricing_status"]): string {
  if (status === "known") return "完整计价";
  if (status === "partial") return "部分计价";
  return "未知计价";
}

function formatDate(value: string | null): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(1)} s`;
}

function displayError(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError && cause.message) return cause.message;
  if (cause instanceof Error && cause.message) return cause.message;
  return fallback;
}
