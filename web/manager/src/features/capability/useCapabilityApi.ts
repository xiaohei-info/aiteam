/**
 * 能力目录 API hook（能力目录 CRUD）。
 *
 * 只调本端 /api/manager/skills|connectors|memory-policies/*（跨端由基类拦截）。
 * 目录写操作需 owner/enterprise_admin（后端鉴权兜底，前端仅做 UI 门控）。
 */
import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type {
  SkillCatalog,
  ConnectorCatalog,
  MemoryPolicyCatalog,
  SkillCatalogIn,
  ConnectorCatalogIn,
  MemoryPolicyCatalogIn,
  SkillImportInput,
  SkillImportResponse,
} from "./types";

const M = "/api/manager";

export interface CapabilityApi {
  listSkills: () => Promise<SkillCatalog[]>;
  listConnectors: () => Promise<ConnectorCatalog[]>;
  listMemoryPolicies: () => Promise<MemoryPolicyCatalog[]>;
  createSkill: (input: SkillCatalogIn) => Promise<SkillCatalog | null>;
  updateSkill: (catalogId: string, input: SkillCatalogIn) => Promise<SkillCatalog | null>;
  deleteSkill: (catalogId: string) => Promise<void>;
  createConnector: (input: ConnectorCatalogIn) => Promise<ConnectorCatalog | null>;
  updateConnector: (catalogId: string, input: ConnectorCatalogIn) => Promise<ConnectorCatalog | null>;
  deleteConnector: (catalogId: string) => Promise<void>;
  createMemoryPolicy: (input: MemoryPolicyCatalogIn) => Promise<MemoryPolicyCatalog | null>;
  updateMemoryPolicy: (catalogId: string, input: MemoryPolicyCatalogIn) => Promise<MemoryPolicyCatalog | null>;
  deleteMemoryPolicy: (catalogId: string) => Promise<void>;
  /** 检查要导入的技能（不写库）。 */
  previewSkillImport: (input: SkillImportInput) => Promise<SkillImportResponse | null>;
  /** 把勾选的技能写入企业目录。 */
  importSkills: (input: SkillImportInput) => Promise<SkillImportResponse | null>;
}

const UPLOAD_SOURCES = new Set(["folder", "zip", "file"]);

/** 上传来源用 multipart（文件 + 相对路径），其余用 JSON。 */
function importBody(input: SkillImportInput): FormData | Record<string, unknown> {
  if (!UPLOAD_SOURCES.has(input.source)) {
    const { files: _files, ...json } = input;
    return json;
  }
  const form = new FormData();
  form.append("source", input.source);
  for (const item of input.files ?? []) {
    form.append("files", item.file, item.file.name);
    form.append("paths", item.path);
  }
  for (const root of input.roots ?? []) form.append("roots", root);
  for (const key of ["visibility", "binding_policy", "install_policy"] as const) {
    if (input[key]) form.append(key, input[key]!);
  }
  return form;
}

export function useCapabilityApi(): CapabilityApi {
  const { token, onUnauthorized } = useSession();
  return useMemo(() => {
    const c = createManagerApiClient({ getToken: () => token, onUnauthorized });
    const postSkill = (input: SkillCatalogIn) => c.post<SkillCatalog>("/api/manager/skills", { body: input });
    const putSkill = (catalogId: string, input: SkillCatalogIn) => c.put<SkillCatalog>(`/api/manager/skills/${catalogId}`, { body: input });
    const delSkill = (catalogId: string) => c.del<void>(`/api/manager/skills/${catalogId}`);
    const postConn = (input: ConnectorCatalogIn) => c.post<ConnectorCatalog>("/api/manager/connectors", { body: input });
    const putConn = (catalogId: string, input: ConnectorCatalogIn) => c.put<ConnectorCatalog>(`/api/manager/connectors/${catalogId}`, { body: input });
    const delConn = (catalogId: string) => c.del<void>(`/api/manager/connectors/${catalogId}`);
    const postMem = (input: MemoryPolicyCatalogIn) => c.post<MemoryPolicyCatalog>("/api/manager/memory-policies", { body: input });
    const putMem = (catalogId: string, input: MemoryPolicyCatalogIn) => c.put<MemoryPolicyCatalog>(`/api/manager/memory-policies/${catalogId}`, { body: input });
    const delMem = (catalogId: string) => c.del<void>(`/api/manager/memory-policies/${catalogId}`);
    return {
      async listSkills() { return (await c.listGet<SkillCatalog>("/api/manager/skills")).items; },
      async listConnectors() { return (await c.listGet<ConnectorCatalog>("/api/manager/connectors")).items; },
      async listMemoryPolicies() { return (await c.listGet<MemoryPolicyCatalog>("/api/manager/memory-policies")).items; },
      createSkill: (input) => postSkill(input),
      updateSkill: (catalogId, input) => putSkill(catalogId, input),
      deleteSkill: async (catalogId) => { await delSkill(catalogId); },
      createConnector: (input) => postConn(input),
      updateConnector: (catalogId, input) => putConn(catalogId, input),
      deleteConnector: async (catalogId) => { await delConn(catalogId); },
      createMemoryPolicy: (input) => postMem(input),
      updateMemoryPolicy: (catalogId, input) => putMem(catalogId, input),
      deleteMemoryPolicy: async (catalogId) => { await delMem(catalogId); },
      previewSkillImport: (input) => c.post<SkillImportResponse>(`${M}/skills/import/preview`, { body: importBody(input) }),
      importSkills: (input) => c.post<SkillImportResponse>(`${M}/skills/import`, { body: importBody(input) }),
    };
  }, [token, onUnauthorized]);
}
