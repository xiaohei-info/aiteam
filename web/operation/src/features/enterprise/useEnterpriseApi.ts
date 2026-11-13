/**
 * 企业开通 API hook（W-O.2）。
 *
 * 封装本端 /api/operation/enterprises/* 调用，只调本端路径。
 * 路径已对齐后端 routes_enterprise.py：
 *   POST /enterprises（开通）
 * 重置管理员密码已迁到账号管理的行菜单（accounts/ResetOwnerDialog）。
 */
import type { ApiClient } from "../../api";
import type { PlatformModelRef } from "../catalog/types";

export interface ProvisionInput {
  enterprise_name: string;
  owner_phone: string;
  enterprise_code?: string;
  industry?: string;
  tags?: string[];
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

function writeKey(prefix: string): string {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

export interface EnterpriseProfile {
  enterprise_id: string;
  industry: string | null;
  tags: string[];
}

export function useEnterpriseApi(client: ApiClient) {
  async function provision(input: ProvisionInput): Promise<ProvisionOutput> {
    const data = await client.post<ProvisionOutput>(
      "/api/operation/enterprises",
      { body: input, idempotencyKey: writeKey("enterprise-provision") },
    );
    if (!data) throw new Error("provision 返回空");
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

  async function getProfile(enterpriseId: string): Promise<EnterpriseProfile> {
    const data = await client.get<EnterpriseProfile>(`/api/operation/enterprises/${enterpriseId}/profile`);
    if (!data) throw new Error("profile 返回空");
    return data;
  }

  async function setProfile(enterpriseId: string, body: { industry: string | null; tags: string[] }): Promise<EnterpriseProfile> {
    const data = await client.put<EnterpriseProfile>(`/api/operation/enterprises/${enterpriseId}/profile`, { body });
    if (!data) throw new Error("profile 返回空");
    return data;
  }

  return { provision, getModelAccess, setModelAccess, getProfile, setProfile };
}
