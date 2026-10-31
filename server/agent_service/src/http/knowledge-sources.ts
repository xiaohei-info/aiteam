import { Type, type TProperties, type TSchema } from "typebox";
import type { Router } from "./local-directories.js";
import type { AuthenticatedCaller } from "./auth.js";
import { validateReadQuery } from "../services/conversation-reads.js";
import type { LocalDirectoryService } from "../services/local-directories.js";
import { ManagerAuthorizationError, ManagerUnavailableError, type ManagerClient } from "../manager-client.js";

/**
 * Read-only index of the three knowledge sources a member sees:
 * - enterprise: the tenant's enterprise knowledge base(s), owned by Manager; only the deployment kind is visible.
 * - personal: personal knowledge services are connected and held by the client (URL + token never reach the Agent), so always [].
 * - local: directories registered on this machine; the absolute path stays out of this index.
 * Nothing is cached or uploaded; enterprise items are read with the member's own token on every call.
 */

export const KNOWLEDGE_SOURCES = ["enterprise", "personal", "local"] as const;
export type KnowledgeSource = typeof KNOWLEDGE_SOURCES[number];

export class KnowledgeSourceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "KnowledgeSourceError";
  }
}

const str = (description: string) => Type.String({ description });
const obj = <T extends TProperties>(properties: T, description: string) => Type.Object(properties, { additionalProperties: false, description });
const SourceSchema = Type.String({ enum: [...KNOWLEDGE_SOURCES], description: "知识来源：enterprise 企业 / personal 个人 / local 本机。" });

export const KnowledgeSourceItemSchema = obj({
  source: SourceSchema,
  id: str("来源内 ID：企业为 knowledge_space_id，本机为 directory_id。"),
  name: str("展示名称。"),
  deployment: Type.String({ enum: ["managed", "nas", "this_device"], description: "部署位置：managed=Manager 托管，nas=企业内网 NAS（经 Manager 网关），this_device=本机。不含地址与凭据。" }),
  status: str("可用状态；企业为 ready，本机为目录检查结果（如 ready、authorization_unavailable）。"),
}, "一条知识来源；只读索引，不含正文、地址或凭据。");

const SourceState = (states: string[], description: string) => Type.String({ enum: states, description });
const KnowledgeSourcesMeta = obj({
  enterprise: SourceState(["ok", "unavailable", "not_requested"], "企业来源读取结果；未筛选时 Manager 不可用记为 unavailable，不影响其余来源。"),
  personal: SourceState(["client_held", "not_requested"], "个人知识服务由客户端直连并保存令牌，Agent 不代理也不列出。"),
  local: SourceState(["ok", "host_unavailable", "not_requested"], "本机目录宿主状态。"),
}, "各来源读取状态。");
const Query = obj({ source: Type.Optional(SourceSchema) }, "来源筛选；不传返回全部三类。");

const json = (schema: TSchema) => ({ content: { "application/json": { schema } } });
const problem = (description: string) => ({ content: { "application/problem+json": { schema: Type.Ref("Problem") } }, description });

type SourceItem = { source: KnowledgeSource; id: string; name: string; deployment: string; status: string };
type SourceMeta = { enterprise: string; personal: string; local: string };

function readSource(query: URLSearchParams): KnowledgeSource | undefined {
  const source = query.get("source");
  if (source === null) return undefined;
  if (!(KNOWLEDGE_SOURCES as readonly string[]).includes(source)) throw new KnowledgeSourceError(422, "invalid_source", "source must be enterprise, personal or local");
  return source as KnowledgeSource;
}

export function knowledgeSourceProblem(error: unknown): Error {
  if (error instanceof ManagerAuthorizationError) {
    return error.status === 401
      ? new KnowledgeSourceError(401, "unauthenticated", "Manager authentication is required")
      : new KnowledgeSourceError(403, "knowledge_forbidden", "Manager denied access to enterprise knowledge");
  }
  if (error instanceof ManagerUnavailableError) return new KnowledgeSourceError(503, "manager_unavailable", "Manager is unavailable");
  return error instanceof Error ? error : new Error("Knowledge source request failed");
}

export function registerKnowledgeSourceRoutes(
  router: Router,
  managerClient: () => ManagerClient | undefined,
  localDirectories: LocalDirectoryService,
): void {
  const enterprise = async (caller: AuthenticatedCaller): Promise<SourceItem[]> => {
    const client = managerClient();
    if (!client?.listKnowledgeSpaces) throw new KnowledgeSourceError(503, "manager_unavailable", "Enterprise knowledge is unavailable");
    try {
      const spaces = await client.listKnowledgeSpaces(caller);
      return spaces.map((space) => ({
        source: "enterprise", id: space.knowledge_space_id, name: space.display_name || space.knowledge_space_id,
        deployment: space.deployment_kind, status: "ready",
      }));
    } catch (error) {
      throw knowledgeSourceProblem(error);
    }
  };

  router.register("GET", "/api/agent/knowledge-sources", async (req, res, caller) => {
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    validateReadQuery(query, ["source"]);
    const only = readSource(query);
    const wants = (source: KnowledgeSource) => only === undefined || only === source;
    const data: SourceItem[] = [];
    const meta: SourceMeta = { enterprise: "not_requested", personal: "not_requested", local: "not_requested" };

    if (wants("enterprise")) {
      try {
        data.push(...await enterprise(caller!));
        meta.enterprise = "ok";
      } catch (error) {
        // An explicit enterprise request reports the failure; the combined view keeps local sources usable.
        if (only === "enterprise" || (error instanceof KnowledgeSourceError && error.status === 401)) throw error;
        meta.enterprise = "unavailable";
      }
    }
    if (wants("personal")) meta.personal = "client_held";
    if (wants("local")) {
      const local = await localDirectories.list(caller!);
      meta.local = local.available ? "ok" : "host_unavailable";
      for (const directory of local.directories) {
        data.push({ source: "local", id: directory.directory_id, name: directory.display_name, deployment: "this_device", status: directory.status });
      }
    }
    router.send(res, 200, { data, meta });
  }, {
    operationId: "listKnowledgeSources",
    summary: "列出企业 / 个人 / 本机知识来源",
    description: "只读索引当前成员可见的三类知识来源。enterprise：转发到 Manager，用成员自己的登录身份读取本企业知识库，只返回部署位置（Manager 托管或企业 NAS），从不返回 NAS 地址或凭据；数据归 Manager 当前 tenant。personal：个人知识服务由客户端直连、令牌只存在客户端，本接口恒为空并在 meta 中标为 client_held。local：本机已注册目录，数据只在本机，不返回绝对路径。不传 source 时 Manager 不可用只把 meta.enterprise 记为 unavailable；source=enterprise 时直接返回 401/403/503。不缓存、不上传任何内容。",
    tags: ["knowledge-sources"],
    querystring: Query,
    response: {
      200: json(obj({ data: Type.Array(KnowledgeSourceItemSchema, { description: "按 企业、本机 顺序排列的知识来源。" }), meta: KnowledgeSourcesMeta }, "知识来源列表")),
      401: problem("Unauthorized"), 403: problem("Forbidden"), 422: problem("ValidationError"), 503: problem("ManagerUnavailable"),
    },
  });
}

export const KNOWLEDGE_SOURCE_PARAMETER_EXAMPLES = { source: "enterprise" };

export const KNOWLEDGE_SOURCE_OPERATION_DOCS = {
  listKnowledgeSources: {
    request: { source: { summary: "只看企业", value: "enterprise" } },
    responses: { "200": { description: "当前成员可见的知识来源。", examples: {
      all: { summary: "三类来源", value: {
        data: [
          { source: "enterprise", id: "enterprise_shared", name: "企业知识库", deployment: "nas", status: "ready" },
          { source: "local", id: "directory-1", name: "项目资料", deployment: "this_device", status: "ready" },
        ],
        meta: { enterprise: "ok", personal: "client_held", local: "ok" },
      } },
    } } },
  },
};
