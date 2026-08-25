/**
 * 招募 / 应用方案 / 员工生命周期 API hook（W-M.3）。
 *
 * 为 /marketplace、/solutions 与后续入口提供共享 API。
 * 只调本端 /api/manager/recruit/* 与 /api/manager/employees/*（跨端由基类拦截）。
 * 浏览目录是 Operator 只读投影（后端 #118）；招募/应用落本 tenant employee 实例。
 *
 * 注意（PRD B06）：方案实例定义在 Operator 端；Manager 端仅「查看详情 + 应用」，不提供编辑入口。
 */
import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type {
  ApplySolutionInput,
  ApplySolutionResult,
  EmployeeConfig,
  EmployeeConfigIn,
  ExpertTemplate,
  RecruitExpertInput,
  LifecycleOptions,
  SolutionInstance,
  SolutionPackage,
} from "./types";

export interface ExpertsApi {
  listTemplates: () => Promise<ExpertTemplate[]>;
  listSolutions: () => Promise<SolutionPackage[]>;
  recruitExpert: (input: RecruitExpertInput) => Promise<unknown>;
  applySolution: (input: ApplySolutionInput) => Promise<ApplySolutionResult | null>;
  listEmployees: () => Promise<EmployeeConfig[]>;
  updateEmployee: (employeeId: string, config: EmployeeConfigIn) => Promise<EmployeeConfig | null>;
  transitionEmployee: (employeeId: string, transition: string, reason?: string) => Promise<EmployeeConfig | null>;
  getLifecycleOptions: (employeeId: string) => Promise<LifecycleOptions>;
  listSolutionInstances: () => Promise<SolutionInstance[]>;
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
        return client.post<ApplySolutionResult>("/api/manager/recruit/solutions", { body: input });
      },
      async listEmployees() {
        const r = await client.listGet<EmployeeConfig>("/api/manager/employees");
        return r.items;
      },
      updateEmployee(employeeId, config) {
        // PUT 全量替换（EmployeeConfigIn）：回传载入的完整配置，仅覆盖被编辑字段，保全其余。
        return client.put<EmployeeConfig>(`/api/manager/employees/${employeeId}`, { body: config });
      },
      transitionEmployee(employeeId, transition, reason) {
        const body = reason ? { reason } : undefined;
        return client.post<EmployeeConfig>(
          `/api/manager/employees/${employeeId}/transitions/${transition}`,
          body ? { body } : {},
        );
      },
      async getLifecycleOptions(employeeId) {
        const r = await client.get<LifecycleOptions>(
          `/api/manager/employees/${employeeId}/transitions`,
        );
        if (!r) throw new Error("Failed to load lifecycle options");
        return r;
      },
      async listSolutionInstances() {
        const r = await client.listGet<SolutionInstance>("/api/manager/recruit/solutions");
        return r.items;
      },
    };
  }, [token, onUnauthorized]);
}
