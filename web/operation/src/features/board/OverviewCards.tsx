import type { ReactNode } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { RollupBoard } from "./useBoardApi.js";

interface OverviewCardsProps {
  board: RollupBoard;
}

function fmt(value: number): string {
  return value.toLocaleString("zh-CN");
}

function fmtCost(cost: number | string): string {
  const yuan = typeof cost === "string" ? Number.parseFloat(cost) : cost;
  if (yuan >= 10000) return `${(yuan / 10000).toFixed(2)} 万元`;
  return `¥${yuan.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function MetricContent({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <VStack gap={2}>
      <Text type="supporting" color="secondary">{label}</Text>
      <Text type="display-2" hasTabularNumbers>{value}</Text>
    </VStack>
  );
}

function MetricCard({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <Card role="region" aria-label={`${label}：${value}`} padding={4}>
      <MetricContent label={label} value={value} />
    </Card>
  );
}

export function OverviewCards({ board }: OverviewCardsProps): ReactNode {
  return (
    <Grid columns={{ minWidth: 220, max: 4 }} gap={4}>
      <MetricCard label="企业数" value={fmt(board.enterprise_count)} />
      <MetricCard label="总执行次数" value={fmt(board.run_count)} />
      <MetricCard label="总消耗" value={fmtCost(board.cost_total)} />
      <MetricCard label="总 Token" value={fmt(board.token_total)} />
    </Grid>
  );
}
