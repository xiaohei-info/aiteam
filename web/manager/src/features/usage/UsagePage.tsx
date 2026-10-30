/** 用量监控页 — 租户内 Agent 上报的脱敏小时摘要：合计 + 按员工 / 按成员（无会话内容）。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useUsageApi } from "./useUsageApi";
import { lastLocalDaysWindow } from "./usageWindow";
import type { UsagePricingStatus, UsageStatistics, UsageStatisticsGroup, UsageWindow } from "./types";

type RangeKey = "today" | "last_7_days" | "all";

const RANGES: Array<{ key: RangeKey; label: string; window: () => UsageWindow | null }> = [
  { key: "today", label: "今日", window: () => lastLocalDaysWindow(1) },
  { key: "last_7_days", label: "近 7 天", window: () => lastLocalDaysWindow(7) },
  { key: "all", label: "全部", window: () => null },
];

interface CostFields { cost_total: string | number | null; known_cost_total: string | number | null; pricing_status: UsagePricingStatus }
type GroupRow = UsageStatisticsGroup & { row_key: string } & Record<string, unknown>;

function fmtUsd(value: string | number): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "未定价";
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

/** 未知价格不显示为 0：全部未定价 →「未定价」；部分未定价 →「≥ 已知小计」。 */
export function formatUsageCost(stats: CostFields): string {
  if (stats.pricing_status === "known" && stats.cost_total != null) return fmtUsd(stats.cost_total);
  if (stats.pricing_status === "partial" && stats.known_cost_total != null) return `≥ ${fmtUsd(stats.known_cost_total)}`;
  return "未定价";
}

function successRate(succeeded: number, executions: number): string {
  return executions > 0 ? `${Math.round((succeeded / executions) * 100)}%` : "—";
}

function withRowKeys(groups: UsageStatisticsGroup[] | undefined): GroupRow[] {
  return (groups ?? []).map((group) => ({ ...group, row_key: group.group_id ?? "unattributed" }));
}

export function UsagePage(): ReactNode {
  const api = useUsageApi();
  const [range, setRange] = useState<RangeKey>("today");
  const [byEmployee, setByEmployee] = useState<UsageStatistics | null>(null);
  const [byMember, setByMember] = useState<UsageStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 只采用最近一次请求的结果：切换时间范围后，慢返回的旧范围结果（含失败）一律丢弃。
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++latestRequest.current;
    setLoading(true);
    setError(null);
    const window = RANGES.find((item) => item.key === range)!.window();
    try {
      const [employeeStats, memberStats] = await Promise.all([
        api.getStatistics("employee", window),
        api.getStatistics("member", window),
      ]);
      if (requestId !== latestRequest.current) return;
      setByEmployee(employeeStats);
      setByMember(memberStats);
    } catch (err) {
      if (requestId !== latestRequest.current) return;
      setByEmployee(null);
      setByMember(null);
      setError(err instanceof ApiError ? err.message : "用量数据加载失败");
    } finally {
      if (requestId === latestRequest.current) setLoading(false);
    }
  }, [api, range]);

  useEffect(() => {
    void load();
    // 卸载或换范围后作废进行中的请求。
    return () => { latestRequest.current += 1; };
  }, [load]);

  const columns = useMemo(() => (nameHeader: string): TableColumn<GroupRow>[] => [
    { key: "display_name", header: nameHeader, width: proportional(2), renderCell: (row) => <Text>{row.display_name}</Text> },
    { key: "token_total", header: "Token", width: proportional(1), renderCell: (row) => <Text hasTabularNumbers>{row.token_total.toLocaleString()}</Text> },
    { key: "execution_count", header: "执行", width: proportional(1), renderCell: (row) => <Text hasTabularNumbers>{row.execution_count.toLocaleString()}</Text> },
    { key: "success_rate", header: "成功率", width: proportional(1), renderCell: (row) => <Text hasTabularNumbers>{successRate(row.succeeded_count, row.execution_count)}</Text> },
    { key: "cost", header: "费用（USD）", width: proportional(1), renderCell: (row) => <Text hasTabularNumbers>{formatUsageCost(row)}</Text> },
  ], []);

  const totals = byEmployee;
  const hasUsage = (totals?.execution_count ?? 0) > 0 || (totals?.token_total ?? 0) > 0;

  return (
    <VStack gap={4}>
      <HStack justify="between" align="center">
        <Heading level={1}>用量监控</Heading>
        <HStack gap={1} role="group" aria-label="统计时间范围">
          {RANGES.map((item) => (
            <Button key={item.key} label={item.label} variant={range === item.key ? "primary" : "secondary"} size="sm" aria-pressed={range === item.key} onClick={() => setRange(item.key)} />
          ))}
        </HStack>
      </HStack>
      <Text type="supporting">统计企业内全部成员、全部设备上报的按小时汇总用量；不含会话内容。</Text>

      {error && <Banner status="error" title={error} />}

      {loading && <Card padding={4} role="status" aria-label="用量数据加载中"><Skeleton height={96} /></Card>}

      {!loading && totals && <>
        <Grid columns={{ minWidth: 200, max: 4 }} gap={4}>
          <Metric title="Token" value={totals.token_total.toLocaleString()} hint={`输入 ${totals.input_tokens.toLocaleString()} · 输出 ${totals.output_tokens.toLocaleString()} · 缓存 ${totals.cache_tokens.toLocaleString()}`} />
          <Metric title="费用（USD）" value={formatUsageCost(totals)} hint={totals.unpriced_execution_count > 0 ? `${totals.unpriced_execution_count.toLocaleString()} 次执行未定价` : undefined} />
          <Metric title="执行" value={`${totals.execution_count.toLocaleString()} 次`} />
          <Metric title="成功率" value={successRate(totals.succeeded_count, totals.execution_count)} />
        </Grid>
        {hasUsage ? <>
          <GroupTable title="按员工" nameHeader="员工" rows={withRowKeys(byEmployee?.groups)} columns={columns("员工")} />
          <GroupTable title="按成员" nameHeader="成员" rows={withRowKeys(byMember?.groups)} columns={columns("成员")} />
        </> : <Card padding={4}><EmptyState title="该时间范围内暂无用量" isCompact /></Card>}
      </>}
    </VStack>
  );
}

function GroupTable({ title, nameHeader, rows, columns }: { title: string; nameHeader: string; rows: GroupRow[]; columns: TableColumn<GroupRow>[] }): ReactNode {
  return (
    <VStack gap={2}>
      <Heading level={2}>{title}</Heading>
      <Card padding={0}>
        <Table
          aria-label={`${nameHeader}用量`}
          tableProps={{ "aria-label": `${nameHeader}用量` }}
          data={rows}
          columns={columns}
          idKey="row_key"
          hasHover
          emptyState={<EmptyState title="暂无数据" isCompact />}
        />
      </Card>
    </VStack>
  );
}

function Metric({ title, value, hint }: { title: string; value: string; hint?: string }): ReactNode {
  return (
    <Card padding={4}>
      <VStack gap={1}>
        <Text type="supporting">{title}</Text>
        <Text type="display-2" hasTabularNumbers>{value}</Text>
        {hint && <Text type="supporting">{hint}</Text>}
      </VStack>
    </Card>
  );
}
