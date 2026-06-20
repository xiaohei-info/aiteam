/**
 * 跨企业治理看板 API hook（W-O.4）。
 *
 * 只调本端 /api/operation/rollup/*。
 * 契约不可重定义：脱敏聚合摘要类型本地声明，不可自定义平行 DTO。
 * D13 红线：绝对不返回/展示会话内容、执行明细、raw event 字段。
 */
import { useMemo } from "react";
import { createOperationApiClient, type ApiClient } from "../../api/index.js";
import { useSession } from "../../auth/session.js";

// ---- 脱敏聚合摘要类型（本地声明，待后端契约稳定后移入 @aiteam/shared）----

/** 跨企业总览聚合（04 §6.5 脱敏聚合指标）。 */
export interface RollupBoard {
  enterprise_count: number;
  total_runs: number;
  total_cost_cents: number;
  total_tokens: number;
  active_window_start: string;
  active_window_end: string;
}

/** 单企业 rollup 详情（04 §6.5 按窗口 usage 聚合 + audit 摘要）。 */
export interface EnterpriseRollup {
  enterprise_id: string;
  enterprise_name: string;
  window_start: string;
  window_end: string;
  run_count: number;
  cost_cents: number;
  total_tokens: number;
  /** 审计摘要（脱敏：不含执行内容/明细）。 */
  audit_summary: AuditSummary | null;
}

/** 脱敏审计摘要（D13：绝不包含 message/prompt/token/raw event 详细字段）。 */
export interface AuditSummary {
  total_runs: number;
  success_runs: number;
  failed_runs: number;
  avg_duration_seconds: number;
  top_error_codes: string[];
}

/** 本 feature 暴露的 API 表面。 */
export interface BoardApi {
  getBoard: () => Promise<RollupBoard | null>;
  getEnterpriseRollup: (enterpriseId: string) => Promise<EnterpriseRollup | null>;
}

function createBoardApi(client: ApiClient): BoardApi {
  return {
    async getBoard(): Promise<RollupBoard | null> {
      return client.get<RollupBoard>("/api/operation/rollup/board");
    },
    async getEnterpriseRollup(enterpriseId: string): Promise<EnterpriseRollup | null> {
      return client.get<EnterpriseRollup>(
        `/api/operation/rollup/enterprises/${enterpriseId}`,
      );
    },
  };
}

/**
 * 看板 API hook：从会话取 token，构建本端 api-client，暴露 board 领域方法。
 * 组件卸载时不影响 api-client（无状态，无需 dispose）。
 */
export function useBoardApi(): BoardApi {
  const { token, onUnauthorized } = useSession();

  return useMemo(() => {
    const client = createOperationApiClient({
      getToken: () => token,
      onUnauthorized,
    });
    return createBoardApi(client);
  }, [token, onUnauthorized]);
}
