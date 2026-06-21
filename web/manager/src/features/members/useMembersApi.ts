/**
 * 成员账号 API hook（W-M.2）。
 *
 * 封装 createManagerApiClient → 本端 /api/manager/members、/api/manager/departments 调用。
 * 只调本端路径（跨端由基类 assertOwnTierPath 拦截）；调用方只消费包装函数，不触碰 token。
 * 红线：成员凭据不回显——本 hook 不返回/缓存任何 secret（后端 MemberOut 本就不含凭据）。
 */
import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { CreateMemberInput, Department, Member, UpdateMemberInput } from "./types";

export interface MembersApi {
  listMembers: () => Promise<Member[]>;
  createMember: (input: CreateMemberInput) => Promise<Member | null>;
  updateMember: (memberId: string, input: UpdateMemberInput) => Promise<Member | null>;
  deleteMember: (memberId: string) => Promise<void>;
  listDepartments: () => Promise<Department[]>;
}

export function useMembersApi(): MembersApi {
  const { token, onUnauthorized } = useSession();

  return useMemo<MembersApi>(() => {
    const client = createManagerApiClient({
      getToken: () => token,
      onUnauthorized,
    });

    return {
      async listMembers() {
        const result = await client.listGet<Member>("/api/manager/members");
        return result.items;
      },
      createMember(input) {
        return client.post<Member>("/api/manager/members", { body: input });
      },
      updateMember(memberId, input) {
        return client.patch<Member>(`/api/manager/members/${memberId}`, { body: input });
      },
      async deleteMember(memberId) {
        await client.del(`/api/manager/members/${memberId}`);
      },
      async listDepartments() {
        const result = await client.listGet<Department>("/api/manager/departments");
        return result.items;
      },
    };
  }, [token, onUnauthorized]);
}
