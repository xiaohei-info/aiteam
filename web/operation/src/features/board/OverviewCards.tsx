/**
 * 总览指标卡（W-O.4）。
 *
 * 纯展示组件：消费脱敏聚合指标，渲染卡片网格。
 * D13：不渲染 message/prompt/token/content 等会话内容键名。
 * 黑金玻璃质感，复用 shared 组件（GlassPanel）。
 */
import type { ReactNode } from "react";
import { GlassPanel } from "@aiteam/shared/ui";
import type { RollupBoard } from "./useBoardApi.js";

interface OverviewCardsProps {
  board: RollupBoard;
  onEnterpriseClick?: () => void;
}

/** 格式化数字（千分位）。 */
function fmt(val: number): string {
  return val.toLocaleString("zh-CN");
}

/** 格式化金额（cost_total 为 Decimal→string，支持 number|string）。 */
function fmtCost(cost: number | string): string {
  const yuan = typeof cost === "string" ? parseFloat(cost) : cost;
  if (yuan >= 10000) {
    return `${(yuan / 10000).toFixed(2)} 万元`;
  }
  return `¥${yuan.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface CardProps {
  label: string;
  value: string;
  onClick?: () => void;
}

function MetricCard({ label, value, onClick }: CardProps): ReactNode {
  const clickable = Boolean(onClick);
  return (
    <GlassPanel
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        clickable
          ? (e: React.KeyboardEvent<HTMLDivElement>) => {
              if (e.key === "Enter" || e.key === " ") onClick?.();
            }
          : undefined
      }
      className="flex flex-col gap-xs rounded-window p-md"
    >
      <span className="text-xs text-text-secondary">{label}</span>
      <span className="text-xl font-bold text-text-primary">{value}</span>
    </GlassPanel>
  );
}

export function OverviewCards({ board, onEnterpriseClick }: OverviewCardsProps): ReactNode {
  return (
    <div className="grid grid-cols-2 gap-md md:grid-cols-4">
      <MetricCard label="企业数" value={fmt(board.enterprise_count)} onClick={onEnterpriseClick} />
      <MetricCard label="总执行次数" value={fmt(board.run_count)} />
      <MetricCard label="总消耗" value={fmtCost(board.cost_total)} />
      <MetricCard label="总 Token" value={fmt(board.token_total)} />
    </div>
  );
}
