/**
 * 企业端能力更新红点（设计「技能MCP命名空间出处与更新提示」§4.5b）。
 * 侧栏「技能管理」「MCP 市场」读这里；技能列表、「添加平台技能」、MCP 市场读到列表后也写回这里，
 * 所以在页面上点「更新」后红点立刻消失，不用等下一次定时检查。
 */
import { useSyncExternalStore } from "react";
import type { McpMarket } from "../mcp-market/types";
import type { PlatformSkillMarketItem } from "../skill-market/types";

export type CapabilityUpdateCounts = { skills: number; mcps: number };

let counts: CapabilityUpdateCounts = { skills: 0, mcps: 0 };
const listeners = new Set<() => void>();

/** 已安装且平台有新版本的平台技能。 */
export function countSkillUpdates(items: readonly Pick<PlatformSkillMarketItem, "installed" | "update_available">[]): number {
  return items.filter((item) => item.installed && item.update_available).length;
}

/** 已启用且平台有新修订的平台 MCP。 */
export function countMcpUpdates(market: Pick<McpMarket, "servers"> | null | undefined): number {
  return (market?.servers ?? []).filter((server) => server.enabled && server.update_available).length;
}

export function reportCapabilityUpdates(next: Partial<CapabilityUpdateCounts>): void {
  const merged = { ...counts, ...next };
  if (merged.skills === counts.skills && merged.mcps === counts.mcps) return;
  counts = merged;
  for (const listener of listeners) listener();
}

export function resetCapabilityUpdates(): void {
  reportCapabilityUpdates({ skills: 0, mcps: 0 });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useCapabilityUpdateCounts(): CapabilityUpdateCounts {
  return useSyncExternalStore(subscribe, () => counts, () => counts);
}

export function capabilityUpdateLabel(count: number): string {
  return `${count} 项有更新`;
}
