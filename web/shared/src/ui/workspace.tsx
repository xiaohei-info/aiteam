/**
 * Workspace — 对话+时间线双栏工作台壳。
 * 主区（flex-1）+ 可选右面板（玻璃，平板以下隐藏）。表现-only、可测，承载 Run/Loop 执行态。
 */
import type { ReactNode } from "react";
import { GlassPanel } from "./glass-panel.js";

export interface WorkspaceProps {
  /** 主区（对话/主内容）。 */
  children: ReactNode;
  /** 右侧面板内容（如执行时间线）；缺省则不渲染右栏。 */
  panel?: ReactNode;
  panelTitle?: ReactNode;
}

/** 双栏工作台：主区（flex-1）+ 可选右面板（玻璃，平板以下隐藏）。表现-only。 */
export function Workspace({ children, panel, panelTitle }: WorkspaceProps): ReactNode {
  return (
    <div className="flex h-full min-h-0 gap-md">
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      {panel != null ? (
        <GlassPanel
          data-testid="ws-panel"
          className="hidden w-64 shrink-0 flex-col gap-sm rounded-window p-md lg:flex"
        >
          {panelTitle != null ? (
            <div className="text-xs font-bold tracking-wider text-text-muted">{panelTitle}</div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto">{panel}</div>
        </GlassPanel>
      ) : null}
    </div>
  );
}
