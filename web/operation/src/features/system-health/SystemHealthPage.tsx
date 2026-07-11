import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useSystemHealthApi } from "./useSystemHealthApi.js";
import type { SystemHealth } from "./types.js";

interface HealthRow extends Record<string, unknown> { name: string; status: string }
function variant(status: string): BadgeVariant {
  if (status === "up" || status === "healthy") return "success";
  if (status === "local") return "info";
  return "error";
}

export function SystemHealthPage(): ReactNode {
  const api = useSystemHealthApi();
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const columns = useMemo<TableColumn<HealthRow>[]>(() => [
    { key: "name", header: "服务", width: proportional(1) },
    { key: "status", header: "状态", width: proportional(1), renderCell: (row) => <Badge label={row.status} variant={variant(row.status)} /> },
  ], []);

  const load = useCallback(async () => {
    const requestId = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const nextHealth = await api.getHealth();
      if (requestId === sequence.current) setHealth(nextHealth);
    } catch {
      if (requestId === sequence.current) {
        setHealth(null);
        setError("系统健康加载失败");
      }
    } finally {
      if (requestId === sequence.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);
  const rows: HealthRow[] = health ? Object.entries(health.services).map(([name, status]) => ({ name, status })) : [];

  return (
    <VStack as="section" gap={6}>
      <Heading level={1}>系统健康</Heading>
      {loading ? (
        <Card role="status" aria-label="系统健康加载中"><Skeleton height={120} /></Card>
      ) : error ? (
        <Banner status="error" title={error} endContent={<Button label="重试" variant="ghost" onClick={load} />} />
      ) : health ? (
        <>
          <Card>
            <HStack justify="between" align="center">
              <Badge label={health.status} variant={variant(health.status)} />
              <Text type="supporting" color="secondary">{health.timestamp}</Text>
            </HStack>
          </Card>
          <Card padding={0}>
            <Table aria-label="服务健康状态" tableProps={{ "aria-label": "服务健康状态" }} data={rows} columns={columns} idKey="name" />
          </Card>
        </>
      ) : <EmptyState title="暂无数据" />}
    </VStack>
  );
}
