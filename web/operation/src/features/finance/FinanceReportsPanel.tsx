/** S04 财务报表明细面板 — 汇总卡 + 三 tab 明细表。 */
import { useMemo, useState, type ReactNode } from "react";
import { Button, GlassPanel, Table } from "@aiteam/shared/ui";
import type { FinanceReport } from "./types.js";

type TabKey = "recharge" | "consumption" | "profit";
const TABS: { key: TabKey; label: string }[] = [
  { key: "recharge", label: "充值明细" },
  { key: "consumption", label: "消耗明细" },
  { key: "profit", label: "利润明细" },
];

const COLUMN_HEADERS: Record<string, string> = {
  recharge_id: "充值单号",
  enterprise_id: "企业",
  amount: "金额",
  created_at: "时间",
  token_total: "Token 用量",
  cost_total: "费用",
  run_count: "运行次数",
  total_revenue: "总收入",
  total_cost: "总成本",
  gross_profit: "毛利润",
  period: "账期",
};

function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return Number.NaN;
}

interface DetailTableProps {
  rows: Array<Record<string, unknown>>;
}

/** 列内省表格：自动从行数据 keys 生成列，并用 COLUMN_HEADERS 映射中文 header。 */
function DetailTable({ rows }: DetailTableProps): ReactNode {
  const columns = useMemo(() => {
    const seen = new Set<string>();
    for (const row of rows) for (const k of Object.keys(row)) seen.add(k);
    return Array.from(seen);
  }, [rows]);

  if (rows.length === 0) {
    return <p className="m-0 py-sm text-xs text-text-muted">暂无数据</p>;
  }

  return (
    <Table>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c}>{COLUMN_HEADERS[c] ?? c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {columns.map((c) => (
              <td key={c}>{String(row[c] ?? "")}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export interface FinanceReportsPanelProps {
  reports: FinanceReport | null;
}

/**
 * 明细面板：汇总卡 + 三 tab 明细表。
 * Tab 切换仅重渲染（数据已全量拉取，不触发 refetch）；period 切换由父级刷新整个 data。
 */
export function FinanceReportsPanel({ reports }: FinanceReportsPanelProps): ReactNode {
  const [tab, setTab] = useState<TabKey>("recharge");

  const summary = useMemo(() => {
    const recharge = reports?.recharge_details ?? [];
    const consumption = reports?.consumption_details ?? [];
    const profit = reports?.profit_details ?? [];

    const rechargeTotal = recharge.reduce((acc, r) => acc + (asNumber(r.amount) || 0), 0);
    const consumptionTotal = consumption.reduce((acc, r) => acc + (asNumber(r.cost_total) || 0), 0);
    const grossProfit = profit.length > 0 ? (asNumber(profit[0]?.gross_profit) || 0) : 0;

    return {
      rechargeCount: recharge.length,
      rechargeTotal,
      consumptionCount: consumption.length,
      consumptionTotal,
      grossProfit,
    };
  }, [reports]);

  const rows =
    tab === "recharge"
      ? reports?.recharge_details ?? []
      : tab === "consumption"
        ? reports?.consumption_details ?? []
        : reports?.profit_details ?? [];

  return (
    <GlassPanel className="flex flex-col gap-md rounded-window p-md">
      <h2 className="m-0 text-sm font-bold text-text-primary">财务报表明细</h2>

      <div className="grid grid-cols-3 gap-md">
        {[
          { label: "充值笔数", value: String(summary.rechargeCount), accent: "text-gold-bright" },
          { label: "充值金额", value: `¥${summary.rechargeTotal.toFixed(2)}`, accent: "text-gold-bright" },
          { label: "毛利润", value: `¥${summary.grossProfit.toFixed(2)}`, accent: "text-success" },
        ].map((c) => (
          <div key={c.label} className="rounded-md border border-gold/10 bg-surface/40 p-sm">
            <p className="m-0 text-xs text-text-muted">{c.label}</p>
            <p className={`m-0 mt-xs text-base font-bold ${c.accent}`}>{c.value}</p>
          </div>
        ))}
      </div>

      <div className="flex gap-xs">
        {TABS.map((t) => (
          <Button key={t.key} variant={tab === t.key ? "metal" : "ghost"} size="sm" onClick={() => setTab(t.key)}>
            {t.label}
          </Button>
        ))}
      </div>

      <DetailTable rows={rows} />
    </GlassPanel>
  );
}
