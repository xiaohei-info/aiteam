/**
 * 企业开通 API hook（W-O.2）。
 *
 * 封装本端 /api/operation/enterprises/* 调用，只调本端路径。
 * 路径已对齐后端 routes_enterprise.py：
 *   POST /enterprises（开通）
 *   POST /enterprises/{id}/owner-bootstrap/reset（重置负责人凭据）
 */
import type { ApiClient } from "../../api";
import type { PlatformModelRef } from "../catalog/types";

export interface ProvisionInput {
  enterprise_name: string;
  owner_phone: string;
  enterprise_code?: string;
  /** null keeps all published models; [] explicitly opens none. */
  allowed_model_refs?: PlatformModelRef[] | null;
}

export interface ProvisionOutput {
  enterprise_id: string;
  tenant_id: string;
  enterprise_name: string;
  enterprise_code?: string | null;
  owner_phone: string;
  owner_bootstrap_secret: string;
  must_reset: boolean;
  allowed_model_refs?: PlatformModelRef[] | null;
}

export interface EnterpriseModelAccess {
  enterprise_id: string;
  tenant_id: string;
  allowed_model_refs: PlatformModelRef[] | null;
}

export interface ResetOutput {
  enterprise_id: string;
  tenant_id: string;
  owner_phone: string;
  owner_bootstrap_secret: string;
  must_reset: boolean;
}

export function useEnterpriseApi(client: ApiClient) {
  async function provision(input: ProvisionInput): Promise<ProvisionOutput> {
    const data = await client.post<ProvisionOutput>(
      "/api/operation/enterprises",
      { body: input },
    );
    if (!data) throw new Error("provision 返回空");
    return data;
  }

  async function resetBootstrap(
    enterpriseId: string,
  ): Promise<ResetOutput> {
    const data = await client.post<ResetOutput>(
      `/api/operation/enterprises/${enterpriseId}/owner-bootstrap/reset`,
      {},
    );
    if (!data) throw new Error("reset 返回空");
    return data;
  }

  async function getModelAccess(enterpriseId: string): Promise<EnterpriseModelAccess> {
    const data = await client.get<EnterpriseModelAccess>(
      `/api/operation/admin/enterprises/${enterpriseId}/model-access`,
    );
    if (!data) throw new Error("model access 返回空");
    return data;
  }

  async function setModelAccess(
    enterpriseId: string,
    allowedModelRefs: PlatformModelRef[] | null,
  ): Promise<EnterpriseModelAccess> {
    const data = await client.patch<EnterpriseModelAccess>(
      `/api/operation/admin/enterprises/${enterpriseId}/model-access`,
      { body: { allowed_model_refs: allowedModelRefs } },
    );
    if (!data) throw new Error("model access 返回空");
    return data;
  }

  return { provision, resetBootstrap, getModelAccess, setModelAccess };
}
