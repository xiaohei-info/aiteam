import { useMemo, useState, type ReactNode } from "react";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Table, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { FinanceReport } from "./types.js";

type TabKey = "recharge" | "consumption" | "profit";
interface DetailRow extends Record<string, unknown> { _rowKey: string }
const TABS: { key: TabKey; label: string }[] = [
  { key: "recharge", label: "充值明细" },
  { key: "consumption", label: "消耗明细" },
  { key: "profit", label: "利润明细" },
];
const COLUMN_HEADERS: Record<string, string> = {
  recharge_id: "充值单号", enterprise_id: "企业", amount: "金额", created_at: "时间",
  token_total: "Token 用量", cost_total: "API 成本（USD）", run_count: "运行次数",
  total_revenue: "总收入（CNY）", total_cost: "API 成本（USD）", gross_profit: "毛利润", period: "账期",
};

function fmtUsd(value: unknown): string {
  const usd = asNumber(value);
  return Number.isFinite(usd) ? `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}` : "—";
}

function formatCell(key: string, value: unknown): string {
  if (key === "cost_total" || key === "total_cost") return fmtUsd(value);
  if (key === "gross_profit") return value == null ? "—" : `¥${String(value)}`;
  return String(value ?? "");
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) return Number(value);
  return Number.NaN;
}

function Metric({ label, value }: { label: string; value: string }): ReactNode {
  return <Card role="region" aria-label={`${label}：${value}`}><VStack gap={2}><Text type="supporting" color="secondary">{label}</Text><Text type="large" hasTabularNumbers>{value}</Text></VStack></Card>;
}

export interface FinanceReportsPanelProps { reports: FinanceReport | null }

export function FinanceReportsPanel({ reports }: FinanceReportsPanelProps): ReactNode {
  const [tab, setTab] = useState<TabKey>("recharge");
  const summary = useMemo(() => {
    const recharge = reports?.recharge_details ?? [];
    const profit = reports?.profit_details ?? [];
    return {
      rechargeCount: recharge.length,
      rechargeTotal: recharge.reduce((total, row) => total + (asNumber(row.amount) || 0), 0),
      grossProfit: profit.length ? profit[0]?.gross_profit : null,
    };
  }, [reports]);
  const rawRows = tab === "recharge"
    ? reports?.recharge_details ?? []
    : tab === "consumption"
      ? reports?.consumption_details ?? []
      : reports?.profit_details ?? [];
  const rows: DetailRow[] = rawRows.map((row, index) => ({ ...row, _rowKey: `${tab}-${index}` }));
  const keys = useMemo(() => {
    const seen = new Set<string>();
    for (const row of rawRows) for (const key of Object.keys(row)) seen.add(key);
    return [...seen];
  }, [rawRows]);
  const columns = useMemo<TableColumn<DetailRow>[]>(() => keys.map((key) => ({
    key,
    header: COLUMN_HEADERS[key] ?? key,
    width: proportional(1),
    renderCell: (row) => formatCell(key, row[key]),
  })), [keys]);
  const activeLabel = TABS.find((item) => item.key === tab)?.label ?? "财务明细";

  return (
    <VStack as="section" gap={4}>
      <Heading level={2}>财务报表明细</Heading>
      <Grid columns={{ minWidth: 180, max: 3 }} gap={3}>
        <Metric label="充值笔数" value={String(summary.rechargeCount)} />
        <Metric label="充值金额（CNY）" value={`¥${summary.rechargeTotal.toFixed(2)}`} />
        <Metric label="毛利润" value={summary.grossProfit === null ? "—" : `¥${summary.grossProfit}`} />
      </Grid>
      <TabList aria-label="财务报表类型" value={tab} onChange={(value) => setTab(value as TabKey)} hasDivider>
        {TABS.map((item) => <Tab key={item.key} value={item.key} label={item.label} />)}
      </TabList>
      <Card padding={0}>
        <Table
          aria-label={activeLabel}
          tableProps={{ "aria-label": activeLabel }}
          data={rows}
          columns={columns}
          idKey="_rowKey"
          emptyState={<EmptyState title="暂无数据" isCompact />}
        />
      </Card>
    </VStack>
  );
}
