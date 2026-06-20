/**
 * 跨企业总览看板页（W-O.4）。
 *
 * GET /api/operation/rollup/board → 渲染总览面板。
 * D13：只展示脱敏聚合摘要，绝不渲染会话内容/执行明细/raw event。
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type RollupBoard, useBoardApi } from "./useBoardApi.js";
import { OverviewCards } from "./OverviewCards.js";

export function BoardPage(): React.ReactNode {
  const api = useBoardApi();
  const navigate = useNavigate();
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
      <section className="board-page board-page--loading">
        <p className="board-page__status">加载中…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="board-page board-page--error">
        <p className="board-page__status board-page__status--error">{error}</p>
        <button
          className="board-page__retry"
          onClick={fetchBoard}
          type="button"
        >
          重试
        </button>
      </section>
    );
  }

  return (
    <section className="board-page">
      <h1 className="board-page__title">跨企业治理看板</h1>
      {board ? (
        <OverviewCards board={board} onEnterpriseClick={handleEnterpriseClick} />
      ) : (
        <p className="board-page__status">暂无数据</p>
      )}
    </section>
  );
}
