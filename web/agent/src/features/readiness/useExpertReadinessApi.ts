/**
 * W-A.5 专家 readiness 适配层（AITEAM-693）。
 *
 * 镜像后端 ``ReadinessService`` 返回的 JSON 结构；不重定义契约——后端是真相源，前端按
 * 就绪状态渲染标记并在 ``available=false`` 时阻断操作、展示具体原因。
 */

import type { AgentApiClient } from "../../lib/api-client";

export type ReadinessState = "ready" | "degraded" | "blocked" | "unknown";

export interface SkillReadiness {
  ref: string;
  status: ReadinessState;
  reason?: string;
  version?: string;
}

export interface CapabilityReadiness {
  kind: "knowledge" | "memory" | "connector";
  refs: string[];
  status: ReadinessState;
  reason?: string;
}

export interface ExpertReadiness {
  employee_id: string;
  display_name: string;
  handle: string;
  available: boolean;
  runtime: ReadinessState;
  provider: ReadinessState;
  skills: SkillReadiness[];
  capabilities: CapabilityReadiness[];
  reasons: string[];
}

export interface ReadinessReport {
  runtime: ReadinessState;
  runtime_reason?: string;
  experts: ExpertReadiness[];
}

/** 列整端 readiness（runtime + 每个已装载专家）。 */
export async function getReadinessReport(
  client: AgentApiClient,
): Promise<ReadinessReport | null> {
  return client.get<ReadinessReport>("/api/agent/grants/readiness");
}

/** 取单个专家 readiness；不存在时后端返回 available:false。 */
export async function getExpertReadiness(
  client: AgentApiClient,
  employeeId: string,
): Promise<ExpertReadiness | null> {
  return client.get<ExpertReadiness>(
    `/api/agent/grants/experts/${encodeURIComponent(employeeId)}/readiness`,
  );
}
