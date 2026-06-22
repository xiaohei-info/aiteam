/**
 * 跨企业治理看板 API hook（W-O.4）。
 *
 * 只调本端 /api/operation/rollups/*。
 * 契约不可重定义：脱敏聚合摘要类型本地声明，不可自定义平行 DTO。
 * D13 红线：绝对不返回/展示会话内容、执行明细、raw event 字段。
 */
import { useMemo } from "react";
import { createOperationApiClient, type ApiClient } from "../../api/index.js";
import { useSession } from "../../auth/session.js";

// ---- 脱敏聚合摘要类型（本地声明，待后端契约稳定后移入 @aiteam/shared）----

/** 单企业 rollup 详情（EnterpriseUsageRollup）。 */
export interface EnterpriseRollup {
  enterprise_id: string;
  tenant_id: string;
  run_count: number;
  token_total: number;
  cost_total: number | string;
  error_count: number;
  duration_seconds_total: number;
  summary_count: number;
  window_start: string;
  window_end: string;
}

/** 跨企业总览聚合（CrossEnterpriseBoard）。 */
export interface RollupBoard {
  enterprise_count: number;
  run_count: number;
  token_total: number;
  cost_total: number | string;
  error_count: number;
  duration_seconds_total: number;
  enterprises: EnterpriseRollup[];
}

/** 本 feature 暴露的 API 表面。 */
export interface BoardApi {
  getBoard: () => Promise<RollupBoard | null>;
  getEnterpriseRollup: (enterpriseId: string) => Promise<EnterpriseRollup | null>;
}

function createBoardApi(client: ApiClient): BoardApi {
  return {
    async getBoard(): Promise<RollupBoard | null> {
      return client.get<RollupBoard>("/api/operation/rollups/board");
    },
    async getEnterpriseRollup(enterpriseId: string): Promise<EnterpriseRollup | null> {
      return client.get<EnterpriseRollup>(`/api/operation/rollups/${enterpriseId}`);
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
