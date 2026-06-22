/**
 * 跨企业总览看板页（W-O.4）。
 *
 * GET /api/operation/rollups/board → 渲染总览面板。
 * D13：只展示脱敏聚合摘要，绝不渲染会话内容/执行明细/raw event。
 * 黑金玻璃质感，复用 shared 组件（Button/GlassPanel）。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, GlassPanel } from "@aiteam/shared/ui";
import { type RollupBoard, useBoardApi } from "./useBoardApi.js";
import { OverviewCards } from "./OverviewCards.js";

export function BoardPage(): ReactNode {
  const api = useBoardApi();
  const [board, setBoard] = useState<RollupBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBoard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getBoard();
      setBoard(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchBoard();
  }, [fetchBoard]);

  const handleEnterpriseClick = useCallback(() => {
    // 暂无企业列表 API，总览指标卡点击暂不跳转
  }, []);

  if (loading) {
    return (
      <section className="flex flex-col gap-md">
        <h1 className="m-0 text-xl font-bold text-text-primary">跨企业治理看板</h1>
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>
      </section>
    );
  }

  if (error) {
    return (
      <section className="flex flex-col gap-md">
        <h1 className="m-0 text-xl font-bold text-text-primary">跨企业治理看板</h1>
        <GlassPanel className="flex flex-col gap-md rounded-window border border-danger/30 p-lg">
          <p className="m-0 text-sm text-danger">{error}</p>
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={fetchBoard}>
            重试
          </Button>
        </GlassPanel>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-lg">
      <h1 className="m-0 text-xl font-bold text-text-primary">跨企业治理看板</h1>
      {board ? (
        <OverviewCards board={board} onEnterpriseClick={handleEnterpriseClick} />
      ) : (
        <GlassPanel className="rounded-window p-lg text-sm text-text-muted">暂无数据</GlassPanel>
      )}
    </section>
  );
}
