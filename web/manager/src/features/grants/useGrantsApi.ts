/**
 * 成员级授权 API hook（W-M.4）。
 *
 * 只调本端 /api/manager/*：grants CRUD + 选择器数据（members/departments/employees/solutions）。
 * 授权资源为 expert(employee 实例) | solution(方案实例)，目标为 部门/成员（D12）。
 */
import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type {
  CreateGrantInput,
  Department,
  ExpertOption,
  Grant,
  Member,
  SolutionOption,
  UpdateGrantInput,
} from "./types";

export interface GrantsApi {
  listGrants: () => Promise<Grant[]>;
  createGrant: (input: CreateGrantInput) => Promise<Grant | null>;
  updateGrant: (grantId: string, input: UpdateGrantInput) => Promise<Grant | null>;
  deleteGrant: (grantId: string) => Promise<void>;
  listMembers: () => Promise<Member[]>;
  listDepartments: () => Promise<Department[]>;
  listExperts: () => Promise<ExpertOption[]>;
  listSolutions: () => Promise<SolutionOption[]>;
}

export function useGrantsApi(): GrantsApi {
  const { token, onUnauthorized } = useSession();

  return useMemo<GrantsApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      async listGrants() {
        return (await client.listGet<Grant>("/api/manager/grants")).items;
      },
      createGrant(input) {
        return client.post<Grant>("/api/manager/grants", { body: input });
      },
      updateGrant(grantId, input) {
        return client.patch<Grant>(`/api/manager/grants/${grantId}`, { body: input });
      },
      async deleteGrant(grantId) {
        await client.del(`/api/manager/grants/${grantId}`);
      },
      async listMembers() {
        return (await client.listGet<Member>("/api/manager/members")).items;
      },
      async listDepartments() {
        return (await client.listGet<Department>("/api/manager/departments")).items;
      },
      async listExperts() {
        return (await client.listGet<ExpertOption>("/api/manager/employees")).items;
      },
      async listSolutions() {
        return (await client.listGet<SolutionOption>("/api/manager/recruit/solutions")).items;
      },
    };
  }, [token, onUnauthorized]);
}
