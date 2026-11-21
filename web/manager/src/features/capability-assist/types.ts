/** 「让模型帮我找」（设计 2026-11-20 §4.5）：与 `server/manager_service/schemas.py` CapabilityAssist* 对齐。 */
import type { SkillSecurity } from "../capability/types";

export interface CapabilityAssistInput {
  requirement: string;
  link?: string;
  config_json?: string;
  model: { provider_id: string; model_id: string };
}

export interface CapabilityAssistCandidate {
  kind: "skill" | "mcp";
  source: "clawhub" | "github" | "url" | "config";
  url: string;
  title: string;
  summary: string;
  reason: string;
  /** 模型用 inspect_link 核实过这个链接。 */
  verified: boolean;
  security?: SkillSecurity | null;
}

export interface CapabilityAssistResult {
  candidates: CapabilityAssistCandidate[];
  notes: string;
  incomplete: boolean;
  dropped: number;
  error?: string | null;
  rounds: number;
  tool_calls: number;
  usage: { input_tokens: number; output_tokens: number; cost: string | null; pricing_status: "known" | "unknown" };
}
