import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Table, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useFinanceApi } from "./useFinanceApi.js";
import { FinanceReportsPanel } from "./FinanceReportsPanel.js";
import type { FinanceOverview, FinanceReport } from "./types.js";

const PERIODS = [
  { key: "month", label: "本月" }, { key: "quarter", label: "本季" },
  { key: "year", label: "本年" }, { key: "all", label: "全部" },
];
interface ConsumerRow extends Record<string, unknown> { id: string; rank: number; name: string; amount: string }

function fmtTokens(value: number): string {
  if (value < 1_000_000) return value.toLocaleString("zh-CN");
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  return `${(value / 1_000_000_000).toFixed(2)}B`;
}

function fmtUsd(value: number | string | null): string {
  const usd = Number(value);
  return Number.isFinite(usd) ? `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}` : "—";
}

function Metric({ label, value }: { label: string; value: string }): ReactNode {
  return <Card role="region" aria-label={`${label}：${value}`}><VStack gap={2}><Text type="supporting" color="secondary">{label}</Text><Text type="display-2" hasTabularNumbers>{value}</Text></VStack></Card>;
}

export function FinancePage(): ReactNode {
  const api = useFinanceApi();
  const sequence = useRef(0);
  const [overview, setOverview] = useState<FinanceOverview | null>(null);
  const [reports, setReports] = useState<FinanceReport | null>(null);
  const [period, setPeriod] = useState("month");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const consumerColumns = useMemo<TableColumn<ConsumerRow>[]>(() => [
    { key: "rank", header: "排名", width: proportional(1) },
    { key: "name", header: "企业", width: proportional(3) },
    { key: "amount", header: "API 成本（USD）", width: proportional(2), renderCell: (row) => <Badge label={fmtUsd(row.amount)} variant="info" /> },
  ], []);

  const load = useCallback(async () => {
    const requestId = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const [nextOverview, nextReports] = await Promise.all([api.getOverview(period), api.getReports(period)]);
      if (requestId !== sequence.current) return;
      setOverview(nextOverview);
      setReports(nextReports);
    } catch (err) {
      if (requestId !== sequence.current) return;
      setOverview(null);
      setReports(null);
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      if (requestId === sequence.current) setLoading(false);
    }
  }, [api, period]);

  useEffect(() => {
    void load();
    return () => { sequence.current += 1; };
  }, [load]);

  const consumers: ConsumerRow[] = (overview?.top5_consumers ?? []).map((consumer, index) => ({
    id: `${index}`,
    rank: index + 1,
    name: String(consumer.name ?? consumer.enterprise_name ?? ""),
    amount: String(consumer.cost_total ?? consumer.cost ?? consumer.amount ?? "0"),
  }));

  return (
    <VStack as="section" gap={6}>
      <Heading level={1}>财务管理</Heading>
      <TabList aria-label="财务统计周期" value={period} onChange={setPeriod}>
        {PERIODS.map((item) => <Tab key={item.key} value={item.key} label={item.label} />)}
      </TabList>
      {loading ? (
        <Card role="status" aria-label="财务数据加载中"><Skeleton height={120} /></Card>
      ) : error ? (
        <Banner status="error" title={error} endContent={<Button label="重试" variant="ghost" onClick={load} />} />
      ) : overview ? (
        <>
          <Grid columns={{ minWidth: 220, max: 4 }} gap={4}>
            <Metric label="总充值金额（CNY）" value={`¥${overview.total_recharged}`} />
            <Metric label="实际调用量（Token）" value={fmtTokens(overview.total_tokens_billed)} />
            <Metric label="API 成本（USD）" value={fmtUsd(overview.total_api_cost)} />
            <Metric label="利润" value={overview.profit_status === "available" && overview.gross_profit !== null ? `¥${overview.gross_profit}` : "—"} />
            <Metric label="利润率" value={overview.profit_status === "available" && overview.profit_margin !== null ? `${overview.profit_margin.toFixed(1)}%` : "—"} />
          </Grid>
          {(overview.unknown_pricing_tokens ?? 0) > 0 && <Banner status="warning" title={`${fmtTokens(overview.unknown_pricing_tokens ?? 0)} 个 Token 尚无价格快照，API 成本未完整计入`} />}
          {consumers.length > 0 && (
            <VStack as="section" gap={3}>
              <Heading level={2}>TOP 5 消费企业</Heading>
              <Card padding={0}>
                <Table aria-label="TOP 5 消费企业" tableProps={{ "aria-label": "TOP 5 消费企业" }} data={consumers} columns={consumerColumns} idKey="id" />
              </Card>
            </VStack>
          )}
          {reports ? <FinanceReportsPanel reports={reports} /> : null}
        </>
      ) : null}
    </VStack>
  );
}
