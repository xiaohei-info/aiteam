import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { type EnterpriseRollup, useBoardApi } from "./useBoardApi.js";

function fmt(value: number): string { return value.toLocaleString("zh-CN"); }
function fmtCost(cost: number | string): string {
  const yuan = typeof cost === "string" ? Number.parseFloat(cost) : cost;
  return yuan >= 10000
    ? `${(yuan / 10000).toFixed(2)} 万元`
    : `¥${yuan.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Metric({ label, value }: { label: string; value: string }): ReactNode {
  return <Card role="region" aria-label={`${label}：${value}`}><VStack gap={2}><Text type="supporting" color="secondary">{label}</Text><Text type="display-2" hasTabularNumbers>{value}</Text></VStack></Card>;
}

export function EnterpriseDetailPage(): ReactNode {
  const { enterprise_id } = useParams<{ enterprise_id: string }>();
  const api = useBoardApi();
  const navigate = useNavigate();
  const sequence = useRef(0);
  const [data, setData] = useState<EnterpriseRollup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDetail = useCallback(async () => {
    if (!enterprise_id) {
      setLoading(false);
      setData(null);
      return;
    }
    const requestId = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getEnterpriseRollup(enterprise_id);
      if (requestId === sequence.current) setData(result);
    } catch (err) {
      if (requestId === sequence.current) setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      if (requestId === sequence.current) setLoading(false);
    }
  }, [api, enterprise_id]);

  useEffect(() => {
    void fetchDetail();
    return () => { sequence.current += 1; };
  }, [fetchDetail]);

  return (
    <VStack as="section" gap={6}>
      <Button label="返回总览" variant="ghost" onClick={() => navigate("/board")} />
      {loading ? (
        <Card role="status" aria-label="企业治理详情加载中"><Skeleton height={120} /></Card>
      ) : error ? (
        <Banner status="error" title={error} endContent={<Button label="重试" variant="ghost" onClick={fetchDetail} />} />
      ) : data ? (
        <>
          <VStack gap={2}>
            <Heading level={1}>{data.enterprise_id}</Heading>
            <Text color="secondary">统计周期：{data.window_start} ~ {data.window_end}</Text>
          </VStack>
          <Grid columns={{ minWidth: 220, max: 3 }} gap={4}>
            <Metric label="执行次数" value={fmt(data.run_count)} />
            <Metric label="消耗" value={fmtCost(data.cost_total)} />
            <Metric label="总 Token" value={fmt(data.token_total)} />
          </Grid>
        </>
      ) : <EmptyState title="暂无数据" />}
    </VStack>
  );
}
