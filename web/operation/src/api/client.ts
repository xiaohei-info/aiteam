/**
 * 运营端 api-client 封装（08 §12.2 + 02 §10.1）。
 *
 * 基于 @aiteam/shared 的 ApiClient 基类，**只调本端** /api/operation/* 与 /api/auth/*。
 * 跨端路径（/api/manager/*、/api/agent/*）由基类 assertOwnTierPath 拦截并抛 ApiError，
 * 在 client 层就消除跨端直调——前端单测覆盖此边界（W-O.1 验收）。
 *
 * 不重定义契约：所有响应类型从 @aiteam/shared/contracts 取。
 */
import { ApiClient, type ApiClientConfig } from "@aiteam/shared";

/** 运营端本端 client 工厂：tier 锁死 operation，调用方无法覆盖。 */
export function createOperationApiClient(
  config: Omit<ApiClientConfig, "tier">,
): ApiClient {
  return new ApiClient({ ...config, tier: "operation" });
}

export type { ApiClient } from "@aiteam/shared";
