import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { OrgTreeNode } from "./types";

export interface OrgApi { getTree: () => Promise<OrgTreeNode | null>; assignDepartment: (assignmentId: string, departmentId: string) => Promise<unknown>; }

export function useOrgApi(): OrgApi {
  const { token, onUnauthorized } = useSession();
  return useMemo<OrgApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      getTree() { return client.get<OrgTreeNode>("/api/manager/org/tree"); },
      assignDepartment(assignment_id, department_id) { return client.patch(`/api/manager/org/assignments/${assignment_id}`, { body: { department_id } }); },
    };
  }, [token, onUnauthorized]);
}
