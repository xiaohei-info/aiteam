/**
 * 总览指标卡（W-O.4）。
 *
 * 纯展示组件：消费脱敏聚合指标，渲染卡片网格。
 * D13：不渲染 message/prompt/token/content 等会话内容键名。
 */
import type { RollupBoard } from "./useBoardApi.js";

interface OverviewCardsProps {
  board: RollupBoard;
  onEnterpriseClick?: () => void;
}

/** 格式化数字（千分位）。 */
function fmt(val: number): string {
  return val.toLocaleString("zh-CN");
}

/** 格式化金额（分→元，带千分位）。 */
function fmtCost(cents: number): string {
  const yuan = cents / 100;
  if (yuan >= 10000) {
    return `${(yuan / 10000).toFixed(2)} 万元`;
  }
  return `¥${yuan.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function OverviewCards({ board, onEnterpriseClick }: OverviewCardsProps): React.ReactNode {
  return (
    <div className="board-overview-cards">
      <div
        className="board-overview-card board-overview-card--clickable"
        onClick={onEnterpriseClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onEnterpriseClick?.();
        }}
      >
        <span className="board-overview-card__label">企业数</span>
        <span className="board-overview-card__value">{fmt(board.enterprise_count)}</span>
      </div>
      <div className="board-overview-card">
        <span className="board-overview-card__label">总执行次数</span>
        <span className="board-overview-card__value">{fmt(board.total_runs)}</span>
      </div>
      <div className="board-overview-card">
        <span className="board-overview-card__label">总消耗</span>
        <span className="board-overview-card__value">{fmtCost(board.total_cost_cents)}</span>
      </div>
      <div className="board-overview-card">
        <span className="board-overview-card__label">总 Token</span>
        <span className="board-overview-card__value">{fmt(board.total_tokens)}</span>
      </div>
    </div>
  );
}
