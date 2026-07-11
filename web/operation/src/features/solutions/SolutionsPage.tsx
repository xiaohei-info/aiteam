import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/CodeBlock";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { VStack } from "@astryxdesign/core/VStack";
import { useSolutionsApi } from "./useSolutionsApi";
import type { SolutionStat } from "./types";

type SolutionRow = SolutionStat & Record<string, unknown>;

export function SolutionsPage(): ReactNode {
  const api = useSolutionsApi();
  const [stats, setStats] = useState<SolutionStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const columns = useMemo<TableColumn<SolutionRow>[]>(() => [
    { key: "solution_id", header: "方案 ID", width: proportional(1), renderCell: (row) => <Code>{row.solution_id}</Code> },
    { key: "name", header: "方案名称", width: proportional(2) },
    { key: "apply_count", header: "应用次数", width: pixel(120) },
    { key: "active_enterprises", header: "活跃企业", width: pixel(120) },
  ], []);

  const load = useCallback(async () => {
    const requestId = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const nextStats = await api.getStats();
      if (requestId === sequence.current) setStats(nextStats);
    } catch (err) {
      if (requestId === sequence.current) {
        setStats([]);
        setError(err instanceof ApiError ? err.message : "加载失败");
      }
    } finally {
      if (requestId === sequence.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  return (
    <VStack as="section" gap={6}>
      <Heading level={1}>行业方案统计</Heading>
      {loading ? (
        <Card role="status" aria-label="方案统计加载中"><Skeleton height={120} /></Card>
      ) : error ? (
        <Banner status="error" title={error} endContent={<Button label="重试" variant="ghost" onClick={load} />} />
      ) : (
        <Card padding={0}>
          <Table
            aria-label="行业方案统计"
            tableProps={{ "aria-label": "行业方案统计" }}
            data={stats as SolutionRow[]}
            columns={columns}
            idKey="solution_id"
            emptyState={<EmptyState title="暂无方案数据" isCompact />}
          />
        </Card>
      )}
    </VStack>
  );
}
