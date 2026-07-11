/**
 * 运营端总览首页（W-O.1）。
 * GET /api/operation/rollups/board → 跨企业脱敏聚合看板。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useI18n } from "../i18n/context";
import { type RollupBoard, useBoardApi } from "../features/board/useBoardApi";

function fmt(v: number): string { return v.toLocaleString("zh-CN"); }
function fmtCost(v: number | string): string {
  const yuan = Number(v) / 100;
  return yuan >= 10000 ? `${(yuan / 10000).toFixed(2)} 万元` : `¥${yuan.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}`;
}

function MetricCard({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <Card padding={4} role="region" aria-label={`${label}：${value}`}>
      <VStack gap={2}>
        <Text type="supporting">{label}</Text>
        <Text type="display-2" hasTabularNumbers>{value}</Text>
      </VStack>
    </Card>
  );
}

export function DashboardPlaceholder(): ReactNode {
  const i18n = useI18n();
  const api = useBoardApi();
  const [board, setBoard] = useState<RollupBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setBoard(await api.getBoard()); }
    catch (err) { setError(err instanceof Error ? err.message : "加载失败"); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  return (
    <VStack gap={6}>
      <Heading level={1}>{i18n.t("operation.nav.dashboard")}</Heading>
      {loading ? (
        <Card padding={4} role="status" aria-label="运营概览加载中">
          <Grid columns={{ minWidth: 220, max: 3 }} gap={4}>
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} height={104} index={index} />
            ))}
          </Grid>
        </Card>
      ) : error ? (
        <Banner
          status="error"
          title={error}
          endContent={<Button label="重试" variant="ghost" onClick={load} />}
        />
      ) : board ? (
        <Grid columns={{ minWidth: 220, max: 3 }} gap={4}>
          <MetricCard label="企业数" value={fmt(board.enterprise_count)} />
          <MetricCard label="执行次数" value={fmt(board.run_count)} />
          <MetricCard label="总消耗" value={fmtCost(board.cost_total)} />
          <MetricCard label="总 Token" value={fmt(board.token_total)} />
          <MetricCard label="错误次数" value={fmt(board.error_count)} />
          <MetricCard label="总耗时（秒）" value={fmt(board.duration_seconds_total)} />
        </Grid>
      ) : (
        <EmptyState
          title="暂无运营汇总数据"
          description="跨企业脱敏聚合数据生成后会显示在这里。"
        />
      )}
    </VStack>
  );
}
