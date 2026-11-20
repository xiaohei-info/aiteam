/**
 * 「让模型帮我找」的候选交接：技能交给技能目录的导入对话框，MCP 交给 MCP 市场的企业 MCP 对话框。
 * 候选属于另一页时经路由 state 带过去，由那一页打开对应对话框；刷新或直接打开页面时没有 state，不做任何事。
 */
import type { CapabilityAssistCandidate } from "./types";

/** 侧栏「技能管理」：默认标签「企业技能」就是技能目录。 */
export const SKILL_PAGE = "/skill-market";
export const MCP_PAGE = "/mcp-market";

interface HandoffState {
  assistCandidate?: CapabilityAssistCandidate;
}

export function handoffState(candidate: CapabilityAssistCandidate): HandoffState {
  return { assistCandidate: candidate };
}

/** 读出发给本页（kind 匹配）的候选。 */
export function readHandoff(state: unknown, kind: CapabilityAssistCandidate["kind"]): CapabilityAssistCandidate | null {
  const candidate = (state as HandoffState | null)?.assistCandidate;
  return candidate && candidate.kind === kind && typeof candidate.url === "string" ? candidate : null;
}

/** 技能候选 → 导入对话框的来源与地址（ClawHub 链接走 ClawHub 来源，其余按网址导入）。 */
export function skillImportInitial(candidate: CapabilityAssistCandidate): { source: "url" | "clawhub"; url: string } {
  return { source: candidate.source === "clawhub" ? "clawhub" : "url", url: candidate.url };
}

/** MCP 候选 → 企业 MCP 对话框的预填。 */
export function mcpDialogInitial(candidate: CapabilityAssistCandidate): { url: string; display_name: string; summary: string } {
  return { url: candidate.url, display_name: candidate.title, summary: candidate.summary };
}
