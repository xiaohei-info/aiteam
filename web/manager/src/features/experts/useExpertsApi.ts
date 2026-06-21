/**
 * 招募专家 API hook（W-M.3）。
 *
 * 只调本端 /api/manager/recruit/* 与 /api/manager/employees/*（跨端由基类拦截）。
 * 浏览目录是 Operator 只读投影（后端 #118）；招募/应用落本 tenant employee 实例。
 */
import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type {
  ApplySolutionInput,
  EmployeeConfig,
  ExpertTemplate,
  RecruitExpertInput,
  SolutionPackage,
} from "./types";

export interface ExpertsApi {
  listTemplates: () => Promise<ExpertTemplate[]>;
  listSolutions: () => Promise<SolutionPackage[]>;
  recruitExpert: (input: RecruitExpertInput) => Promise<unknown>;
  applySolution: (input: ApplySolutionInput) => Promise<unknown>;
  listEmployees: () => Promise<EmployeeConfig[]>;
  updateEmployee: (employeeId: string, config: EmployeeConfig) => Promise<EmployeeConfig | null>;
}

export function useExpertsApi(): ExpertsApi {
  const { token, onUnauthorized } = useSession();

  return useMemo<ExpertsApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      async listTemplates() {
        const r = await client.listGet<ExpertTemplate>("/api/manager/recruit/catalog/experts");
        return r.items;
      },
      async listSolutions() {
        const r = await client.listGet<SolutionPackage>("/api/manager/recruit/catalog/solutions");
        return r.items;
      },
      recruitExpert(input) {
        return client.post("/api/manager/recruit/experts", { body: input });
      },
      applySolution(input) {
        return client.post("/api/manager/recruit/solutions", { body: input });
      },
      async listEmployees() {
        const r = await client.listGet<EmployeeConfig>("/api/manager/employees");
        return r.items;
      },
      updateEmployee(employeeId, config) {
        // PUT 全量替换（EmployeeConfigIn）：回传载入的完整配置，仅覆盖被编辑字段，保全其余。
        const { employee_id, employee_slug, version, ...body } = config;
        void employee_id;
        void employee_slug;
        void version;
        return client.put<EmployeeConfig>(`/api/manager/employees/${employeeId}`, { body });
      },
    };
  }, [token, onUnauthorized]);
}
