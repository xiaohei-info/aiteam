/** B04 工资管理页 — 用量总览 + 明细 + 充值。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useBillingApi } from "./useBillingApi";
import { useExpertsApi } from "../experts/useExpertsApi";
import type { UsageOverview, BillingBalance } from "./types";

const PERIODS = [{ key: "month", label: "本月" }, { key: "last_month", label: "上月" }, { key: "all", label: "全部" }];

function fmtUsd(value: number | string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

export function BillingPage(): ReactNode {
  const api = useBillingApi();
  const expertsApi = useExpertsApi();
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [topEmployeeName, setTopEmployeeName] = useState<string | null>(null);
  const [balance, setBalance] = useState<BillingBalance | null>(null);
  const [period, setPeriod] = useState("month");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, bal] = await Promise.all([api.getOverview(period), api.getBalance()]);
      setOverview(ov); setBalance(bal);
      if (ov?.top_employee_id) {
        const employees = await expertsApi.listEmployees().catch(() => []);
        setTopEmployeeName(employees.find((employee) => employee.employee_id === ov.top_employee_id)?.display_name ?? "已删除专家");
      } else {
        setTopEmployeeName(null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "工资数据加载失败");
    } finally { setLoading(false); }
  }, [api, expertsApi, period]);

  useEffect(() => { void load(); }, [load]);

  return (
    <VStack gap={4}>
      <HStack justify="between" align="center">
        <Heading level={1}>工资管理</Heading>
        <HStack gap={1} role="group" aria-label="账单周期">
          {PERIODS.map((p) => (
            <Button key={p.key} label={p.label} variant={period === p.key ? "primary" : "secondary"} size="sm" aria-pressed={period === p.key} onClick={() => setPeriod(p.key)} />
          ))}
        </HStack>
      </HStack>

      {error && <Banner status="error" title={error} />}

      {balance && (
        <Grid columns={{ minWidth: 220, max: 3 }} gap={4}>
          <Metric title="账户余额" value={`¥${String(balance.balance)}`} />
          <Metric title="预估可用Token" value={balance.estimated_tokens.toLocaleString()} />
          <Metric title="更新时间" value={balance.updated_at?.slice(0, 19) ?? "—"} />
        </Grid>
      )}

      {overview && <>
        <Grid columns={{ minWidth: 220, max: 3 }} gap={4}>
          <Metric title="总消耗 Token" value={overview.total_tokens.toLocaleString()} />
          <Metric title="API 成本（USD）" value={fmtUsd(overview.total_cost)} />
          <Metric title="消耗最高员工" value={topEmployeeName ?? "—"} />
        </Grid>
        {(overview.unknown_pricing_tokens ?? 0) > 0 && <Banner status="warning" title={`${(overview.unknown_pricing_tokens ?? 0).toLocaleString()} 个 Token 尚无价格快照，成本未完整计入`} />}
      </>}

      {loading && <Card padding={4} role="status" aria-label="工资数据加载中"><Skeleton height={96} /></Card>}
    </VStack>
  );
}

function Metric({ title, value }: { title: string; value: string }): ReactNode {
  return <Card padding={4}><VStack gap={1}><Text type="supporting">{title}</Text><Text type="display-2" hasTabularNumbers>{value}</Text></VStack></Card>;
}
