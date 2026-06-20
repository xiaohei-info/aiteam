/**
 * 企业开通 API hook（W-O.2）。
 *
 * 封装本端 /api/operation/enterprises/* 调用，只调本端路径。
 * 契约不重定义：响应类型由调用方自行推断。
 */
import type { ApiClient } from "../../api";

export interface ProvisionInput {
  enterprise_name: string;
  enterprise_slug: string;
}

export interface ProvisionOutput {
  bootstrap_secret: string;
  enterprise_id: string;
}

export interface ResetOutput {
  bootstrap_secret: string;
}

export function useEnterpriseApi(client: ApiClient) {
  async function provision(input: ProvisionInput): Promise<ProvisionOutput> {
    const data = await client.post<ProvisionOutput>(
      "/api/operation/enterprises/provision",
      { body: input },
    );
    if (!data) throw new Error("provision 返回空");
    return data;
  }

  async function resetBootstrap(
    enterpriseId: string,
  ): Promise<ResetOutput> {
    const data = await client.post<ResetOutput>(
      `/api/operation/enterprises/${enterpriseId}/owner/bootstrap/reset`,
      {},
    );
    if (!data) throw new Error("reset 返回空");
    return data;
  }

  return { provision, resetBootstrap };
}
