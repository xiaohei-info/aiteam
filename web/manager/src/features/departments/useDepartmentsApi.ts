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
      deleteDepartment(departmentId) {
        return client.del<DeleteDepartmentResult>(`/api/manager/departments/${departmentId}`);
      },
    };
  }, [token, onUnauthorized]);
}
