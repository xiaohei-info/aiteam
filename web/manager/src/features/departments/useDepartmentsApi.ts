/** 部门管理 API：所有请求经 Manager client 访问本端部门契约。 */
import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type {
  CreateDepartmentInput,
  DeleteDepartmentResult,
  Department,
  UpdateDepartmentInput,
} from "./types";

export interface DepartmentsApi {
  listDepartments: () => Promise<Department[]>;
  getDepartment: (departmentId: string) => Promise<Department | null>;
  createDepartment: (input: CreateDepartmentInput) => Promise<Department | null>;
  updateDepartment: (departmentId: string, input: UpdateDepartmentInput) => Promise<Department | null>;
  /** 下级部门升级：childId 取代 departmentId 的位置，departmentId 成为它的子部门。 */
  promoteDepartment: (departmentId: string, childId: string) => Promise<Department | null>;
  deleteDepartment: (departmentId: string) => Promise<DeleteDepartmentResult | null>;
}

export function useDepartmentsApi(): DepartmentsApi {
  const { token, onUnauthorized } = useSession();

  return useMemo<DepartmentsApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      async listDepartments() {
        return (await client.listGet<Department>("/api/manager/departments")).items;
      },
      getDepartment(departmentId) {
        return client.get<Department>(`/api/manager/departments/${departmentId}`);
      },
      createDepartment(input) {
        return client.post<Department>("/api/manager/departments", { body: input });
      },
      updateDepartment(departmentId, input) {
        return client.patch<Department>(`/api/manager/departments/${departmentId}`, { body: input });
      },
      promoteDepartment(departmentId, childId) {
        return client.post<Department>(`/api/manager/departments/${departmentId}/promote`, { body: { child_id: childId } });
      },
      deleteDepartment(departmentId) {
        return client.del<DeleteDepartmentResult>(`/api/manager/departments/${departmentId}`);
      },
    };
  }, [token, onUnauthorized]);
}
