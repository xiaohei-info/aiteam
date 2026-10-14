import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyRequest } from "fastify";
import { Type, type TProperties, type TSchema } from "typebox";
import type { AuthenticatedCaller } from "./auth.js";
import { LocalDirectoryError } from "../storage/local-directories.js";
import type { LocalDirectoryService } from "../services/local-directories.js";

const str = (description: string, options: Record<string, unknown> = {}) => Type.String({ description, ...options });
const obj = <T extends TProperties>(properties: T, description: string) => Type.Object(properties, { additionalProperties: false, description });

const DirectoryEmployeeBinding = obj({
  employee_id: str("数字员工 ID"),
  enabled: Type.Boolean({ description: "是否启用该目录绑定" }),
  revision: Type.Integer({ minimum: 1, description: "员工绑定乐观并发版本号" }),
}, "数字员工与本地知识目录的绑定状态");

const LocalDirectoryResource = obj({
  directory_id: str("本地知识目录稳定 ID"),
  display_name: str("目录显示名称"),
  path: str("当前成员在桌面设置页可见的本地规范路径"),
  revision: Type.Integer({ minimum: 1, description: "目录授权乐观并发版本号" }),
  status: str("目录实时状态（ready 或不可用原因码）"),
  bindings: Type.Array(DirectoryEmployeeBinding, { description: "员工级绑定状态详情" }),
}, "受控本地知识目录资源（不含源文档内容）");

const LocalDirectoryListPayload = obj({
  available: Type.Boolean({ description: "宿主本地目录桥接是否可用" }),
  formats: Type.Array(str("支持的文档后缀"), { description: "当前版本支持的只读文本格式" }),
  directories: Type.Array(LocalDirectoryResource, { description: "当前成员已注册的本地知识目录" }),
}, "本地知识目录列表视图");

const ChallengeResource = obj({
  challenge: str("单次目录授权挑战令牌"),
}, "宿主原生目录选择器一次性挑战");

const RegisteredDirectoryResource = obj({
  directory_id: str("本地知识目录稳定 ID"),
  display_name: str("目录显示名称"),
  canonical_path: str("桌面宿主规范路径"),
  revision: Type.Integer({ minimum: 1, description: "目录版本号" }),
  created_at: str("目录注册时间"),
}, "已注册的本地知识目录记录");

const BindingUpdateResource = obj({
  employee_id: str("数字员工 ID"),
  directory_id: str("本地知识目录 ID"),
  enabled: Type.Boolean({ description: "更新后的绑定状态" }),
  revision: Type.Integer({ minimum: 1, description: "更新后的员工绑定版本号" }),
}, "员工绑定更新结果");

const RevokeDirectoryResource = obj({
  revoked: Type.Boolean({ description: "是否已撤销" }),
  directory_id: str("已撤销的本地知识目录 ID"),
}, "目录撤销结果");

const VerifiedCitationResource = obj({
  citation_id: str("会话内单轮有效的引用句柄 ID"),
  directory_id: str("所属本地知识目录 ID"),
  directory_display_name: str("所属本地知识目录名称"),
  conversation_id: str("所属会话 ID"),
  employee_id: str("执行检索的数字员工 ID"),
  turn_id: str("执行轮次 ID"),
  title: str("文件名"),
  relative_path: str("目录内相对路径"),
  content_version: str("引用创建时的文件版本指纹"),
  snippet: str("检索命中摘要片段"),
  text: str("实时重验权限后按需读取的原文内容"),
  offset: Type.Integer({ minimum: 0, description: "Unicode 码点起始偏移" }),
  next_offset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], { description: "下一页码点偏移" }),
}, "经实时重验权限的本地目录引用详情");

const envelope = (schema: TSchema) => obj({ data: schema }, "成功响应");
const json = (schema: TSchema) => ({ content: { "application/json": { schema } } });
const problem = (description: string) => ({ content: { "application/problem+json": { schema: Type.Ref("Problem") } }, description });

const DirectoryParams = obj({ directory_id: str("本地知识目录 ID", { minLength: 1 }) }, "目录路径参数");
const BindingParams = obj({
  directory_id: str("本地知识目录 ID", { minLength: 1 }),
  employee_id: str("数字员工 ID", { minLength: 1 }),
}, "目录员工绑定路径参数");
const CitationParams = obj({ citation_id: str("引用句柄 ID", { minLength: 1 }) }, "引用句柄路径参数");

type Handler = (request: IncomingMessage, response: ServerResponse, caller?: AuthenticatedCaller, fastifyRequest?: FastifyRequest) => void | Promise<void>;

export interface Router {
  register(method: string, path: string, handler: Handler, schema: Record<string, unknown>): void;
  read(request: IncomingMessage): Promise<Record<string, unknown>>;
  send(response: ServerResponse, status: number, value: unknown): void;
}

export function mapLocalDirectoryError(error: LocalDirectoryError): { status: number; code: string; detail: string } {
  switch (error.code) {
    case "unauthorized":
      return { status: 403, code: "local_directory_unauthorized", detail: "Authenticated caller is not authorized for this local directory resource" };
    case "not_found":
      return { status: 404, code: "local_directory_not_found", detail: "Local directory resource was not found" };
    case "citation_expired":
      return { status: 404, code: "local_directory_citation_expired", detail: "Citation handle is expired or unknown" };
    case "revision_conflict":
    case "conflict":
      return { status: 409, code: "local_directory_revision_conflict", detail: "Local directory binding revision conflict; reload the current revision and retry" };
    case "source_changed":
      return { status: 409, code: "local_directory_source_changed", detail: "Source file changed since citation was created" };
    case "authorization_unavailable":
      return { status: 503, code: "local_directory_host_unavailable", detail: "Native desktop directory host is unavailable" };
    default:
      return { status: 422, code: `local_directory_${error.code}`, detail: error.message };
  }
}

export function registerLocalDirectoryRoutes(router: Router, service: LocalDirectoryService): void {
  const prefix = "/api/agent/local-directories";
  const schema = (operationId: string, summary: string, response: TSchema, extras: Record<string, unknown> = {}, status = 200) => ({
    operationId,
    summary,
    description: `${summary}。仅当前已验证 JWT 身份的 tenant/member 可访问；不持久化源文档正文。`,
    tags: ["local-directories"],
    ...extras,
    response: {
      [status]: json(response),
      401: problem("Unauthorized"),
      403: problem("Forbidden"),
      404: problem("NotFound"),
      409: problem("Conflict"),
      422: problem("ValidationError"),
      503: problem("ManagerUnavailable"),
    },
  });

  router.register(
    "GET",
    prefix,
    async (_req, res, caller) => {
      const result = await service.list(caller!);
      router.send(res, 200, {
        data: {
          available: result.available,
          formats: result.formats,
          directories: result.directories.map((directory) => ({
            directory_id: directory.directory_id,
            display_name: directory.display_name,
            path: directory.path,
            revision: directory.revision,
            status: directory.status,
            bindings: directory.bindings.map((binding) => ({ employee_id: binding.employee_id, enabled: binding.enabled, revision: binding.revision })),
          })),
        },
      });
    },
    schema("listLocalDirectories", "列出当前成员授权的本地知识目录与绑定状态", envelope(LocalDirectoryListPayload)),
  );

  router.register(
    "POST",
    `${prefix}/challenges`,
    async (_req, res, caller) => {
      const challenge = await service.challenge(caller!);
      router.send(res, 201, { data: { challenge } });
    },
    schema("createLocalDirectoryChallenge", "创建本地目录原生选择器授权挑战", envelope(ChallengeResource), {}, 201),
  );

  router.register(
    "POST",
    prefix,
    async (req, res, caller) => {
      const body = await router.read(req);
      if ("path" in body || "canonical_path" in body || "root_path" in body || "directory_path" in body) {
        throw new LocalDirectoryError("invalid_request");
      }
      const ticket = typeof body.ticket === "string" ? body.ticket.trim() : typeof body.ticket_id === "string" ? body.ticket_id.trim() : "";
      if (!ticket) throw new LocalDirectoryError("invalid_request");
      const created = await service.register(caller!, ticket);
      router.send(res, 201, {
        data: {
          directory_id: created.directory_id,
          display_name: created.display_name,
          canonical_path: created.canonical_path,
          revision: created.revision,
          created_at: created.created_at,
        },
      });
    },
    schema("registerLocalDirectory", "凭原生宿主一次性授权票据注册本地知识目录", envelope(RegisteredDirectoryResource), {
      body: obj({
        ticket: Type.Optional(str("Tauri 原生目录选择器签发的一次性票据", { minLength: 1 })),
        ticket_id: Type.Optional(str("ticket 的兼容字段名", { minLength: 1 })),
      }, "注册本地知识目录请求（禁止直接提交宿主路径）"),
    }, 201),
  );

  router.register(
    "PUT",
    `${prefix}/:directory_id/bindings/:employee_id`,
    async (req, res, caller, fastify) => {
      const params = fastify?.params as { directory_id: string; employee_id: string };
      const body = await router.read(req);
      if (typeof body.enabled !== "boolean") throw new LocalDirectoryError("invalid_request");
      const expectedRevision = body.expected_revision === undefined ? 0 : Number(body.expected_revision);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new LocalDirectoryError("invalid_request");
      const updated = await service.bind(caller!, params.directory_id, params.employee_id, body.enabled, expectedRevision);
      router.send(res, 200, { data: { employee_id: updated.employee_id, directory_id: updated.directory_id, enabled: updated.enabled, revision: updated.revision } });
    },
    schema("setLocalDirectoryBinding", "绑定或解绑数字员工的本地知识目录权限", envelope(BindingUpdateResource), {
      params: BindingParams,
      body: obj({
        enabled: Type.Boolean({ description: "true 为授权该员工检索此目录，false 为解除绑定" }),
        expected_revision: Type.Optional(Type.Integer({ minimum: 0, description: "员工绑定乐观并发版本号（首次绑定为 0）" })),
      }, "员工目录绑定更新请求"),
    }),
  );

  router.register(
    "DELETE",
    `${prefix}/:directory_id`,
    (_req, res, caller, fastify) => {
      const params = fastify?.params as { directory_id: string };
      service.revoke(caller!, params.directory_id);
      router.send(res, 200, { data: { revoked: true, directory_id: params.directory_id } });
    },
    schema("revokeLocalDirectory", "撤销本地知识目录授权并立即中止在途访问", envelope(RevokeDirectoryResource), {
      params: DirectoryParams,
    }),
  );

  router.register(
    "POST",
    "/api/agent/local-directory-citations/:citation_id/verify",
    async (req, res, caller, fastify) => {
      const params = fastify?.params as { citation_id: string };
      const body = await router.read(req);
      const offset = body.offset === undefined ? 0 : Number(body.offset);
      if (!Number.isInteger(offset) || offset < 0) throw new LocalDirectoryError("invalid_offset");
      const verified = await service.verifyCitation(caller!, params.citation_id, offset);
      service.assertCitationCurrent(caller!, params.citation_id);
      router.send(res, 200, { data: verified });
    },
    schema("verifyLocalDirectoryCitation", "实时重验本地目录引用句柄并返回受控原文片段", envelope(VerifiedCitationResource), {
      params: CitationParams,
      body: obj({
        offset: Type.Optional(Type.Integer({ minimum: 0, description: "可选 Unicode 码点偏移覆盖" })),
      }, "引用片段校验请求"),
    }),
  );
}

const exampleDirectory = {
  directory_id: "dir_7f9a3e2c1b4d8f01a2c3d4e5",
  display_name: "产品设计规范",
  path: "/Users/example/Documents/Specs",
  revision: 1,
  status: "ready",
  bindings: [{
    employee_id: "employee-1",
    enabled: true,
    revision: 1,
  }],
};

const exampleCitation = {
  citation_id: "localdir:4a8b9c0d-1e2f-3a4b-5c6d-7e8f9a0b1c2d",
  directory_id: exampleDirectory.directory_id,
  directory_display_name: exampleDirectory.display_name,
  conversation_id: "conversation-1",
  employee_id: "employee-1",
  turn_id: "turn-1",
  title: "onboarding.md",
  relative_path: "handbook/onboarding.md",
  content_version: "1:100:1726963200:0:64",
  snippet: "# 入职指南\n欢迎加入团队。",
  text: "# 入职指南\n欢迎加入团队。",
  offset: 0,
  next_offset: null,
};

const exampleRegistered = {
  directory_id: exampleDirectory.directory_id,
  display_name: exampleDirectory.display_name,
  canonical_path: exampleDirectory.path,
  revision: 1,
  created_at: "2026-09-22T00:00:00.000Z",
};

const exampleBinding = {
  employee_id: "employee-1",
  directory_id: exampleDirectory.directory_id,
  enabled: true,
  revision: 1,
};

export const LOCAL_DIRECTORY_PARAMETER_EXAMPLES = {
  directory_id: exampleDirectory.directory_id,
  citation_id: exampleCitation.citation_id,
};

export const LOCAL_DIRECTORY_OPERATION_DOCS = {
  listLocalDirectories: {
    responses: {
      "200": {
        description: "当前成员注册的本地知识目录列表与宿主状态。",
        examples: {
          list: {
            summary: "本地目录列表",
            value: { data: { available: true, formats: [".txt", ".md", ".markdown", ".csv", ".json", ".log"], directories: [exampleDirectory] } },
          },
        },
      },
    },
  },
  createLocalDirectoryChallenge: {
    responses: {
      "201": {
        description: "一次性宿主选择器挑战。",
        examples: { created: { summary: "挑战已生成", value: { data: { challenge: "chg_123456" } } } },
      },
    },
  },
  registerLocalDirectory: {
    request: {
      register: {
        summary: "凭宿主票据注册目录",
        value: { ticket: "tkt_654321" },
      },
    },
    responses: {
      "201": {
        description: "已注册的本地知识目录记录。",
        examples: { registered: { summary: "注册成功", value: { data: exampleRegistered } } },
      },
    },
  },
  setLocalDirectoryBinding: {
    request: {
      bind: {
        summary: "更新员工目录绑定",
        value: { enabled: true, expected_revision: 0 },
      },
    },
    responses: {
      "200": {
        description: "更新后的员工绑定状态。",
        examples: { updated: { summary: "绑定已更新", value: { data: exampleBinding } } },
      },
    },
  },
  revokeLocalDirectory: {
    responses: {
      "200": {
        description: "已撤销的本地知识目录。",
        examples: { revoked: { summary: "已撤销", value: { data: { revoked: true, directory_id: exampleDirectory.directory_id } } } },
      },
    },
  },
  verifyLocalDirectoryCitation: {
    request: {
      verify: {
        summary: "校验引用句柄并读取片段",
        value: { offset: 0 },
      },
    },
    responses: {
      "200": {
        description: "实时权限复核通过后的引用片段与全文块。",
        examples: { verified: { summary: "引用有效", value: { data: exampleCitation } } },
      },
    },
  },
};
