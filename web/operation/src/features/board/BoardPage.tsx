import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { VStack } from "@astryxdesign/core/VStack";
import { type RollupBoard, useBoardApi } from "./useBoardApi.js";
import { OverviewCards } from "./OverviewCards.js";

export function BoardPage(): ReactNode {
  const api = useBoardApi();
  const [board, setBoard] = useState<RollupBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  const fetchBoard = useCallback(async () => {
    const requestId = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const nextBoard = await api.getBoard();
      if (requestId === sequence.current) setBoard(nextBoard);
    } catch (err) {
      if (requestId === sequence.current) {
        setBoard(null);
        setError(err instanceof Error ? err.message : "加载失败");
      }
    } finally {
      if (requestId === sequence.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => { void fetchBoard(); }, [fetchBoard]);

  return (
    <VStack as="section" gap={6}>
      <Heading level={1}>跨企业治理看板</Heading>
      {loading ? (
        <Card role="status" aria-label="治理看板加载中"><Skeleton height={120} /></Card>
      ) : error ? (
        <Banner status="error" title={error} endContent={<Button label="重试" variant="ghost" onClick={fetchBoard} />} />
      ) : board ? (
        <OverviewCards board={board} />
      ) : (
        <EmptyState title="暂无数据" description="脱敏聚合摘要生成后会显示在这里。" />
      )}
    </VStack>
  );
}
