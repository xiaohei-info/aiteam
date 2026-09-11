import { Check } from "typebox/value";
import { GroupConfigurationError, validateCustomGroup } from "../groups/orchestration.js";
import { CustomGroupCreateRequest, GroupOrchestration } from "./custom-group-schemas.js";
import { createHash, randomUUID } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve, relative, isAbsolute } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { Type } from "typebox";
import { ConversationBusyError, EventCursorStaleError, InvalidEventCursorError, type PiEventEnvelope, SessionHost } from "../pi/session-host.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import { IdempotencyConflictError, IdempotencyUnknownError, type AgentSqliteStore } from "../storage/sqlite.js";
import type { AuthenticatedCaller, AuthenticateRequest } from "./auth.js";
import { ManagerAuthError, ManagerAuthorizationError, ManagerUnavailableError, normalizeAuthorizedConfig, type ManagerClient, type MarketplaceTemplate } from "../manager-client.js";
import { SessionAuthorizationError } from "../pi/session-host.js";
import { serializePiEvent } from "../pi/event-sse.js";
import { InvalidReadCursorError } from "../storage/read-cursor.js";
import { ConversationReadError, ConversationReadService, readPageLimit, validateReadQuery } from "../services/conversation-reads.js";
import { employeeDisplay } from "../services/employee-display.js";
import { CONVERSATION_READ_DOCS, CONVERSATION_READ_SCHEMAS, EmployeeDisplayProperties, HistoryQuery, MessageSearchQuery } from "./conversation-read-schemas.js";
import { WORK_RECORD_DOCS, WORK_RECORD_SCHEMAS, WorkHistoryQuery, WorkChangesQuery, UsageStatisticsQuery } from "./work-record-schemas.js";
import { WorkRecordReadService } from "../services/work-records.js";
import { GroupCreationError, GroupCreationService, type GroupParticipantSeed, type ResolvedGroupConversation } from "../services/group-creation.js";
import { UsageStatisticsService } from "../services/usage-statistics.js";
import { normalizePermissionMode, type ConversationPermissionMode, type ConversationState, type LoadedExpertProjection, type LocalFileKind } from "../storage/sqlite.js";
import { validateSchedule } from "../schedule.js";
import type { UsageFlushService } from "../usage-flush.js";
import { SkillCache, SkillVerificationError, skillRefsForSnapshot, skillSigningVerificationForSnapshot, skillSigningVerificationFromEnv, verifySignedSkillPackage } from "../skills.js";
import { ALLOWED_FILE_MIMES, AUDIO_MIMES, hasImageSignature, IMAGE_MIMES, MAX_LOCAL_FILE_BYTES } from "../local-files.js";
export type { AuthenticatedCaller, AuthenticateRequest } from "./auth.js";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_LOCAL_FILE_NAME = 255;
const MAX_PROMPT_IMAGES = 8;
const MAX_PROMPT_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BASE64_FILE_CHARS = Math.ceil(MAX_LOCAL_FILE_BYTES / 3) * 4;
const MAX_UPLOAD_JSON_BYTES = MAX_BASE64_FILE_CHARS + 64 * 1024;
const MAX_AUDIO_RESPONSE_BYTES = 2 * 1024 * 1024;
const FILE_MIME_TYPES = [...ALLOWED_FILE_MIMES].sort();
const AUDIO_MIME_TYPES = [...AUDIO_MIMES].sort();
const IMAGE_MIME_TYPES = [...IMAGE_MIMES].sort();
const require = createRequire(import.meta.url);
const REDOC_BUNDLE = readFileSync(require.resolve("redoc/bundles/redoc.standalone.js"), "utf8");
const FASTIFY_BODY = Symbol("fastifyBody");

type BufferedRequest = IncomingMessage & { [FASTIFY_BODY]?: unknown };
type AgentRouteHandler = (request: IncomingMessage, response: ServerResponse, caller?: AuthenticatedCaller, fastifyRequest?: FastifyRequest) => void | Promise<void>;

const ConversationParams = Type.Object({ conversation_id: Type.String({ minLength: 1, description: "本地会话 ID。" }) }, { additionalProperties: false });
const ConversationFileParams = Type.Object({ conversation_id: Type.String({ minLength: 1, description: "本地会话 ID。" }), attachment_id: Type.String({ minLength: 1, description: "附件 ID。" }) }, { additionalProperties: false });
const ConversationArtifactParams = Type.Object({ conversation_id: Type.String({ minLength: 1, description: "本地会话 ID。" }), artifact_id: Type.String({ minLength: 1, description: "产物 ID。" }) }, { additionalProperties: false });
const ExpertParams = Type.Object({ employee_id: Type.String({ minLength: 1, description: "授权员工/专家 ID。" }) }, { additionalProperties: false });
const KnowledgeBaseParams = Type.Object({
  knowledge_base_id: Type.String({ minLength: 1, description: "已移除接口中的旧知识库 ID。" }),
  kind: Type.String({ minLength: 1, description: "旧知识资源类型。" }),
}, { additionalProperties: false });
const KnowledgeResourceParams = Type.Object({
  knowledge_base_id: Type.String({ minLength: 1, description: "已移除接口中的旧知识库 ID。" }),
  kind: Type.String({ minLength: 1, description: "旧知识资源类型。" }),
  resource_id: Type.String({ minLength: 1, description: "旧知识资源 ID。" }),
}, { additionalProperties: false });
const ConversationQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50, description: "返回条数上限；缺省为 50，最大 100。" })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 8192, description: "原样使用 next_cursor；冻结 updated_at DESC/id DESC 边界并绑定 owner。兼容当前 owner 的旧裸会话 ID，不接受其它资源游标。" })),
}, { additionalProperties: false, description: "本地会话列表查询；该接口不接受 after，事件流断点请使用 events 接口的 after。" });
const PermissionMode = Type.Union([
  Type.Literal("read-only", { description: "只读，不允许本地写入。" }),
  Type.Literal("workspace-write", { description: "仅允许写入当前会话工作区。" }),
  Type.Literal("full-access", { description: "按用户明确选择开放本地访问。" }),
], { $id: "ConversationPermissionMode", description: "会话工作区权限模式。" });
const ConversationState = Type.Union([
  Type.Literal("draft", { description: "草稿会话。" }),
  Type.Literal("active", { description: "可接收提示并执行。" }),
  Type.Literal("paused", { description: "已暂停执行。" }),
  Type.Literal("muted", { description: "已静音，不显示常规提醒。" }),
  Type.Literal("archived", { description: "已归档。" }),
], { $id: "ConversationState", description: "会话持久化状态。" });
const ReadinessState = Type.Union([
  Type.Literal("ready", { description: "依赖就绪。" }),
  Type.Literal("degraded", { description: "可用但能力受限。" }),
  Type.Literal("blocked", { description: "依赖未就绪，不能执行。" }),
  Type.Literal("unknown", { description: "无法确定就绪状态。" }),
], { $id: "ReadinessState", description: "本地执行就绪状态。" });
const BoundedJsonValue = Type.Union([
  Type.String(), Type.Number(), Type.Boolean(), Type.Null(),
  Type.Array(Type.Ref("BoundedJsonValue"), { maxItems: 32 }),
  Type.Record(Type.String({ maxLength: 128 }), Type.Ref("BoundedJsonValue"), { maxProperties: 24 }),
], { $id: "BoundedJsonValue", description: "经脱敏和大小限制后的 JSON 值；顶层可为对象、数组、字符串、数字、布尔值或 null。", "x-dynamic-json": true });
const JsonObject = Type.Record(
  Type.String({ maxLength: 128, description: "扩展 JSON 键。" }),
  Type.Ref("BoundedJsonValue"),
  { maxProperties: 24, description: "扩展 JSON 对象；仅用于 runtime 不稳定的受控元数据。", "x-dynamic-json": true },
);
const PiSseJsonValue = Type.Ref("BoundedJsonValue");
const ScheduleCommon = {
  schedule_id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$", description: "调度稳定标识。" }),
  revision: Type.Optional(Type.Integer({ minimum: 1, description: "调度配置修订号；缺省为 1。" })),
  enabled: Type.Optional(Type.Boolean({ default: true, description: "是否启用调度；缺省为 true。" })),
  overlap: Type.Optional(Type.Literal("skip", { description: "已有执行时跳过本次触发。" })),
  misfire: Type.Optional(Type.Literal("skip", { description: "错过触发时间时跳过。" })),
  prompt_template: Type.String({ minLength: 1, maxLength: 200_000, description: "触发时提交给员工的提示词。" }),
};
const ConversationSchedule = Type.Object({
  ...ScheduleCommon,
  revision: Type.Integer({ minimum: 1, description: "调度配置修订号。" }),
  enabled: Type.Boolean({ description: "是否启用调度。" }),
  at: Type.Optional(Type.String({ format: "date-time", description: "一次性或重复调度锚点（ISO 8601 UTC）。" })),
  interval_seconds: Type.Optional(Type.Integer({ minimum: 1, description: "重复执行间隔（秒）。" })),
  one_shot: Type.Boolean({ description: "是否只执行一次。" }),
  overlap: Type.Literal("skip", { description: "已有执行时跳过本次触发。" }),
  misfire: Type.Literal("skip", { description: "错过触发时间时跳过。" }),
}, { $id: "ConversationSchedule", additionalProperties: false, description: "已规范化的本地会话定时执行配置；响应始终包含 revision、enabled、one_shot、overlap 和 misfire。" });
const ConversationScheduleInput = Type.Union([
  Type.Object({
    ...ScheduleCommon,
    at: Type.String({ format: "date-time", description: "一次性执行时间（ISO 8601 UTC）。" }),
    one_shot: Type.Literal(true, { description: "一次性调度必须为 true。" }),
  }, { additionalProperties: false, description: "一次性调度：必须提供 at，不能提供 interval_seconds。" }),
  Type.Object({
    ...ScheduleCommon,
    at: Type.Optional(Type.String({ format: "date-time", description: "重复调度起始时间（ISO 8601 UTC）；缺省从当前时间基准计算。" })),
    interval_seconds: Type.Integer({ minimum: 1, description: "重复执行间隔（秒）。" }),
    one_shot: Type.Optional(Type.Literal(false, { description: "重复调度应为 false 或省略。" })),
  }, { additionalProperties: false, description: "重复调度：必须提供 interval_seconds，one_shot 不能为 true。" }),
], { $id: "ConversationScheduleInput", description: "创建或更新调度配置；一次性和重复调度使用不同字段组合。" });
const ResolveTenantRequest = Type.Object({
  account: Type.String({ minLength: 1, maxLength: 256, description: "员工手机号或账号。" }),
  enterprise: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "账号跨企业时用于消歧的企业代码或名称。" })),
}, { $id: "ResolveTenantRequest", additionalProperties: false, description: "员工账号企业解析请求。" });
const AgentLoginRequest = Type.Object({
  tenant_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "已解析的企业租户 UUID；省略时服务端按 account/enterprise 自动解析。" })),
  enterprise: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "企业代码或名称；同账号跨企业时用于消歧。" })),
  account: Type.String({ minLength: 1, maxLength: 256, description: "登录账号或手机号。" }),
  password: Type.String({ minLength: 1, maxLength: 512, format: "password", writeOnly: true, description: "登录密码；仅通过请求发送，服务端不会回显。" }),
}, { $id: "AgentLoginRequest", additionalProperties: false, description: "Agent 登录请求；不填 tenant_id 时按 account/enterprise 解析企业，成功后返回本地短期 access token。" });
const AgentResetPasswordRequest = Type.Object({
  tenant_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "已解析的企业租户 UUID；省略时服务端按 account/enterprise 自动解析。" })),
  enterprise: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "企业代码或名称；同账号跨企业时用于消歧。" })),
  account: Type.String({ minLength: 1, maxLength: 256, description: "需要重置密码的负责人账号。" }),
  old_password: Type.String({ minLength: 1, maxLength: 512, format: "password", writeOnly: true, description: "当前密码；仅通过请求发送。" }),
  new_password: Type.String({ minLength: 1, maxLength: 512, format: "password", writeOnly: true, description: "新密码；仅通过请求发送。" }),
}, { $id: "AgentResetPasswordRequest", additionalProperties: false, description: "Agent 密码重置请求；成功后返回新的本地 access token。" });
const ConversationMetadata = Type.Object({
  description: Type.Optional(Type.Union([Type.String({ maxLength: 4000 }), Type.Null()], { description: "群简介，自定义编排时仅供展示。" })),
  orchestration: Type.Optional(Type.Union([Type.Ref("GroupOrchestration"), Type.Null()])),
  id: Type.String({ minLength: 1, description: "会话唯一标识。" }),
  title: Type.Union([Type.String({ maxLength: 200 }), Type.Null()], { description: "会话标题；可为 null。" }),
  kind: Type.String({ minLength: 1, maxLength: 64, description: "会话类型；`group` 启用群聊协作，其他值按普通会话处理。" }),
  labels: Type.Array(Type.String({ maxLength: 128, description: "会话标签。" }), { maxItems: 32, description: "会话标签列表。" }),
  state: Type.Ref("ConversationState"),
  entry_employee_id: Type.Union([Type.String(), Type.Null()], { description: "私聊入口员工 ID。" }),
  coordinator_employee_id: Type.Union([Type.String(), Type.Null()], { description: "群聊协调员工 ID。" }),
  solution_instance_id: Type.Union([Type.String(), Type.Null()], { description: "关联方案实例 ID。" }),
  tenant_id: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "企业租户 ID。" })),
  member_id: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "本地成员 ID。" })),
  schedule: Type.Union([Type.Ref("ConversationSchedule"), Type.Null()], { description: "定时执行配置。" }),
  permission_mode: PermissionMode,
  last_read_entry_id: Type.Union([Type.String(), Type.Null()], { description: "最后读取的 entry_ref；旧存储可能是 raw Pi ID，歧义/失效时按未读处理。" }),
  last_preview: Type.Union([Type.String({ maxLength: 200 }), Type.Null()], { description: "最新可见 user/assistant 的脱敏短文本；排除 thinking/tool/internal，图片为占位符，无消息为 null。" }),
  unread_count: Type.Integer({ minimum: 0, description: "已读位置之后的可见 assistant 消息数；输入和 transient delta 不计数。" }),
  created_at: Type.String({ format: "date-time", description: "创建时间。" }),
  updated_at: Type.String({ format: "date-time", description: "最后更新时间。" }),
}, { $id: "ConversationMetadata", additionalProperties: false, description: "本地会话元数据。" });
const ConversationCreateRequest = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, description: "可选的客户端会话 ID；省略时由服务端生成。" })),
  title: Type.Optional(Type.Union([Type.String({ maxLength: 200, description: "会话标题。" }), Type.Null()])),
  kind: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "会话类型；`group` 创建群聊，缺省为 `chat`。" })),
  labels: Type.Optional(Type.Array(Type.String({ maxLength: 128, description: "会话标签。" }), { maxItems: 32, description: "会话标签列表。" })),
  entry_employee_id: Type.Optional(Type.Union([Type.String({ minLength: 1, description: "私聊入口员工 ID；需要当前成员已授权。" }), Type.Null()])),
  coordinator_employee_id: Type.Optional(Type.Union([Type.String({ minLength: 1, description: "群聊协调员工 ID；需要当前成员已授权。" }), Type.Null()])),
  solution_instance_id: Type.Optional(Type.Union([Type.String({ minLength: 1, description: "已授权方案实例 ID；仅群聊可使用。" }), Type.Null()])),
  permission_mode: Type.Optional(PermissionMode),
  schedule: Type.Optional(Type.Union([Type.Ref("ConversationScheduleInput"), Type.Null()], { description: "定时执行配置；null 表示不启用调度。" })),
}, { $id: "ConversationCreateRequest", additionalProperties: false, description: "创建本地会话请求；群聊的 coordinator/solution 引用必须来自当前成员的本地授权投影。" });
const ConversationUpdateRequest = Type.Object({
  title: Type.Optional(Type.Union([Type.String({ maxLength: 200, description: "会话标题。" }), Type.Null()])),
  kind: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "会话类型；当前实现按部分更新处理。" })),
  labels: Type.Optional(Type.Array(Type.String({ maxLength: 128, description: "会话标签。" }), { maxItems: 32, description: "会话标签列表。" })),
  permission_mode: Type.Optional(PermissionMode),
  schedule: Type.Optional(Type.Union([Type.Ref("ConversationScheduleInput"), Type.Null()], { description: "定时执行配置；null 表示移除调度。" })),
  last_read_entry_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 256, description: "推荐传 entry_ref；兼容该会话内唯一 raw Pi ID。跨会话/歧义/非法引用 422，写入规范化 entry_ref；null 清空。" }), Type.Null()])),
}, { $id: "ConversationUpdateRequest", additionalProperties: false, description: "更新本地会话请求；未提供字段保持不变。" });
const ConversationStateUpdateRequest = Type.Object({ state: Type.Ref("ConversationState") }, { $id: "ConversationStateUpdateRequest", additionalProperties: false, description: "更新会话状态请求。" });
const GrantSyncRequest = Type.Object({ tenant_id: Type.String({ minLength: 1, maxLength: 200, description: "企业租户 ID；必须与当前 access token 一致。" }), member_id: Type.String({ minLength: 1, maxLength: 200, description: "当前成员 ID；必须与当前 access token 一致。" }), known_versions: Type.Optional(Type.Record(Type.String({ minLength: 1, description: "投影键（通常为 employee/solution ID）。" }), Type.String({ minLength: 1, description: "本地已知版本。" }), { maxProperties: 256, description: "投影键到本地版本的映射；省略表示从头获取。" })) }, { $id: "GrantSyncRequest", additionalProperties: false, description: "授权配置增量同步请求；服务端只接受与当前身份匹配的 tenant_id/member_id。" });
const UsageFlushRequest = Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50, description: "本次最多处理的摘要数量；缺省为 50，最大 100。" })) }, { $id: "UsageFlushRequest", additionalProperties: false, description: "用量摘要刷新请求。" });
const ConversationEnvelope = Type.Object({ data: Type.Ref("ConversationMetadata") }, { $id: "ConversationEnvelope", description: "单个会话元数据响应。" });
const ConversationListEnvelope = Type.Object({ data: Type.Array(Type.Ref("ConversationMetadata"), { description: "按 updated_at 降序、id 降序排列的本地会话。" }), page: Type.Ref("Page") }, { $id: "ConversationListEnvelope", description: "会话列表响应；page.next_cursor 为下一页 cursor，末页为 null。" });
const ConversationStateOut = Type.Object({ conversation_id: Type.String({ minLength: 1, description: "会话 ID。" }), state: Type.Ref("ConversationState"), prompting: Type.Boolean({ description: "是否正在执行提示；这是瞬时运行态，不会改变持久化 state。" }) }, { $id: "ConversationStateOut", additionalProperties: false, description: "会话运行状态；state 是持久化状态，prompting 是当前是否有提示执行。" });
const ConversationStateEnvelope = Type.Object({ data: Type.Ref("ConversationStateOut") }, { $id: "ConversationStateEnvelope", description: "会话状态响应。" });
const ThinkingLevel = Type.Union([
  Type.Literal("off", { description: "关闭思考。" }),
  Type.Literal("minimal", { description: "最小思考。" }),
  Type.Literal("low", { description: "低强度思考。" }),
  Type.Literal("medium", { description: "中等思考。" }),
  Type.Literal("high", { description: "高强度思考。" }),
  Type.Literal("xhigh", { description: "超高强度思考。" }),
  Type.Literal("max", { description: "最大思考（由模型能力决定）。" }),
], { $id: "ThinkingLevel", description: "Pi 当前思考档位。" });
const ConversationContextOut = Type.Object({
  conversation_id: Type.String({ description: "会话 ID。" }),
  employee_id: Type.String({ description: "当前上下文对应的授权员工 ID。" }),
  model: Type.Union([Type.Object({ provider: Type.String({ description: "模型 Provider 标识。" }), id: Type.String({ description: "模型标识。" }), name: Type.String({ description: "模型展示名称。" }) }, { additionalProperties: false }), Type.Null()], { description: "当前模型（不含凭据）。" }),
  used_tokens: Type.Union([Type.Integer({ minimum: 0, description: "当前已使用上下文 token 数。" }), Type.Null()], { description: "当前已使用上下文 token 数；SDK 暂不可估算时为 null。" }),
  context_window: Type.Integer({ minimum: 0, description: "当前模型上下文窗口 token 数；不可估算时通常为 0。" }),
  percentage: Type.Union([Type.Number({ minimum: 0, maximum: 100, description: "上下文使用百分比（0–100）。" }), Type.Null()], { description: "上下文使用百分比；token 未知时为 null。" }),
  thinking_level: Type.Ref("ThinkingLevel"),
  available_thinking_levels: Type.Array(Type.Ref("ThinkingLevel"), { description: "当前模型支持的思考档位。" }),
  prompting: Type.Boolean({ description: "当前会话是否正在执行提示。" }),
}, { $id: "ConversationContextOut", additionalProperties: false, description: "本地会话上下文 HUD 数据；不包含会话正文、凭据或运行时原始事件。" });
const ConversationContextEnvelope = Type.Object({ data: Type.Ref("ConversationContextOut") }, { $id: "ConversationContextEnvelope", description: "会话上下文响应；model、used_tokens 和 percentage 允许为 null。" });
const ConversationThinkingLevelRequest = Type.Object({ thinking_level: Type.Ref("ThinkingLevel") }, { $id: "ConversationThinkingLevelRequest", additionalProperties: false, description: "更新本地会话思考档位请求。" });
const ConversationDeleteEnvelope = Type.Object({ data: Type.Object({ deleted: Type.Boolean({ description: "是否删除成功；成功响应固定为 true。" }) }, { additionalProperties: false }) }, { $id: "ConversationDeleteEnvelope", description: "会话删除结果。" });
const ConversationContentPart = Type.Union([
  Type.Object({
    type: Type.Literal("text", { description: "普通文本片段。" }),
    text: Type.String({ description: "文本片段。" }),
  }, { additionalProperties: false, description: "文本内容片段。" }),
  Type.Object({
    type: Type.Literal("thinking", { description: "模型思考片段。" }),
    thinking: Type.String({ description: "思考文本；已做长度限制和敏感信息脱敏。" }),
  }, { additionalProperties: false, description: "思考内容片段。" }),
  Type.Object({
    type: Type.Literal("toolCall", { description: "模型发起的工具调用片段。" }),
    id: Type.Optional(Type.String({ description: "工具调用 ID。" })),
    name: Type.Optional(Type.String({ description: "工具名称。" })),
    arguments: Type.Optional(PiSseJsonValue),
  }, { additionalProperties: false, description: "工具调用内容片段；arguments 是经过边界清洗的 JSON 值。" }),
  Type.Object({
    type: Type.Literal("image", { description: "图片占位片段；图片字节不会通过事件接口返回。" }),
  }, { additionalProperties: false, description: "图片内容占位片段。" }),
], { $id: "ConversationContentPart", description: "脱敏消息内容片段；通过 type 区分 text、thinking、toolCall 和 image。" });
const ConversationMessage = Type.Object({
  role: Type.Union([
    Type.Literal("user", { description: "用户消息。" }),
    Type.Literal("assistant", { description: "员工/模型消息。" }),
    Type.Literal("toolResult", { description: "工具执行结果消息。" }),
  ], { description: "消息角色。" }),
  timestamp: Type.Optional(Type.Integer({ minimum: 0, description: "消息时间戳（Unix 毫秒）。" })),
  content: Type.Optional(Type.Union([
    Type.String({ description: "纯文本消息。" }),
    Type.Array(Type.Ref("ConversationContentPart"), { description: "有序消息内容片段。" }),
  ], { description: "消息内容；可为纯文本或有序内容片段。" })),
  toolCallId: Type.Optional(Type.String({ description: "工具调用 ID；toolResult 消息用于关联调用。" })),
  toolName: Type.Optional(Type.String({ description: "工具名称；toolResult 消息提供。" })),
  isError: Type.Optional(Type.Boolean({ description: "工具结果是否为错误。" })),
}, { $id: "ConversationMessage", additionalProperties: true, description: "脱敏会话消息；assistant 消息可包含 thinking、toolCall 和 text 片段。", "x-dynamic-json": true });
const ConversationEntry = Type.Object({
  work_id: Type.Optional(Type.String({ maxLength: 256, description: "员工本次执行的工作记录 ID；可用于聚合 assistant/toolResult，缺省时不推断执行归属。" })),
  id: Type.String({ description: "原 Pi 条目 ID；跨 participant 可能重复，保留用于旧客户端兼容。" }),
  entry_ref: Type.Optional(Type.String({ description: "conversation/participant/Pi ID 的稳定唯一定位引用；客户端优先用于 key、去重、已读与搜索定位，不是 SSE 或分页 ID。" })),
  participant_employee_id: Type.Optional(Type.String({ description: "条目所属 Session 员工，不等于发送者；旧无员工 Session 可缺省。" })),
  type: Type.String({ description: "条目类型。" }),
  parentId: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "父条目 ID。" })),
  timestamp: Type.Optional(Type.Union([Type.String({ format: "date-time" }), Type.Integer()], { description: "条目时间。" })),
  message: Type.Optional(Type.Ref("ConversationMessage")),
  logical_message_id: Type.Optional(Type.String({ description: "逻辑消息幂等 ID。" })),
  source_type: Type.Optional(Type.String({ enum: ["human", "employee"], description: "消息来源类型。" })),
  source_id: Type.Optional(Type.String({ description: "消息来源 ID。" })),
  source_display_name: Type.Optional(Type.String({ description: "消息来源展示名。" })),
  source_employee_id: Type.Optional(Type.String({ description: "产生该条目的员工 ID。" })),
  source_employee_display_name: Type.Optional(Type.String({ description: "产生该条目的员工展示名。" })),
  source_role: Type.Optional(Type.String({ enum: ["human", "child", "participant", "coordinator"], description: "消息来源角色。" })),
}, { $id: "ConversationEntry", additionalProperties: true, description: "会话历史条目（仅返回脱敏后的持久化视图）。", "x-dynamic-json": true });
const ConversationEntriesEnvelope = Type.Object({ data: Type.Object({ conversation_id: Type.String({ minLength: 1, description: "会话 ID。" }), entries: Type.Array(Type.Ref("ConversationEntry"), { description: "按 timestamp、conversation ID、participant ID、Session append ordinal、Pi entry ID 正序；同逻辑输入去重。" }) }, { additionalProperties: false }), page: Type.Optional(Type.Ref("Page")) }, { $id: "ConversationEntriesEnvelope", description: "无查询参数保持旧 data 形状且不返回 page；提供 limit/cursor/entry_ref 时分页。Pi JSONL 为正文事实源，只读不创建 Session。" });
const PiSseToolCall = Type.Object({
  type: Type.Optional(Type.Union([
    Type.Literal("toolCall", { description: "Pi 工具调用片段。" }),
    Type.Literal("tool_call", { description: "兼容工具调用片段。" }),
    Type.Literal("toolUse", { description: "兼容工具使用片段。" }),
    Type.Literal("tool_use", { description: "兼容工具使用片段。" }),
  ], { description: "工具调用片段类型。" })),
  id: Type.Optional(Type.String({ description: "工具调用 ID；用于关联执行开始、更新和结束事件。" })),
  name: Type.Optional(Type.String({ description: "工具名称，例如 bash、read、todo_update。" })),
  arguments: Type.Optional(PiSseJsonValue),
}, { $id: "PiSseToolCall", additionalProperties: true, description: "SSE 中脱敏后的模型工具调用片段。", "x-dynamic-json": true });
const PiSseAssistantMessageEvent = Type.Object({
  type: Type.String({ enum: [
    "start", "text_start", "text_delta", "text_end",
    "thinking_start", "thinking_delta", "thinking_end",
    "toolcall_start", "toolcall_delta", "toolcall_end", "done", "error",
  ], description: "模型消息增量类别；前端按 thinking/text/toolcall 前缀分类。" }),
  contentIndex: Type.Optional(Type.Integer({ minimum: 0, description: "对应 assistant message content 数组的下标。" })),
  delta: Type.Optional(Type.String({ description: "文本或思考增量；thinking_delta 表示思考文本增量。" })),
  content: Type.Optional(Type.String({ description: "一个内容片段结束时的完整文本。" })),
  reason: Type.Optional(Type.String({ enum: ["stop", "length", "toolUse", "deferred", "aborted", "error"], description: "消息结束或错误原因。" })),
  toolCall: Type.Optional(Type.Ref("PiSseToolCall")),
}, { $id: "PiSseAssistantMessageEvent", additionalProperties: true, description: "message_update.assistantMessageEvent 的脱敏结构。", "x-dynamic-json": true });
const PiSseEventData = Type.Object({
  type: Type.String({ enum: [
    "agent_start", "agent_end", "agent_settled", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end",
    "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end", "approval_required",
  ], description: "SSE data 的顶层事件类别；前端首先按此字段分流。" }),
  conversation_id: Type.Optional(Type.String({ description: "会话 ID。" })),
  source_ref: Type.Optional(Type.String({ description: "群聊/子员工来源引用。" })),
  tool_call_id: Type.Optional(Type.String({ description: "平台附加的工具调用来源 ID。" })),
  source_employee_id: Type.Optional(Type.String({ description: "产生该事件的员工 ID。" })),
  source_employee_display_name: Type.Optional(Type.String({ description: "产生该事件的员工展示名。" })),
  source_role: Type.Optional(Type.String({ enum: ["human", "child", "participant", "coordinator"], description: "事件来源角色。" })),
  message: Type.Optional(Type.Ref("ConversationMessage")),
  assistantMessageEvent: Type.Optional(Type.Ref("PiSseAssistantMessageEvent")),
  toolCallId: Type.Optional(Type.String({ description: "Pi 工具调用 ID；与 toolName、执行事件关联。" })),
  toolName: Type.Optional(Type.String({ description: "工具名称。" })),
  tool_kind: Type.Optional(Type.String({ enum: ["memory", "rag", "todo"], description: "Agent 专用工具类别；普通工具不返回此字段。" })),
  args: Type.Optional(PiSseJsonValue),
  partialResult: Type.Optional(PiSseJsonValue),
  result: Type.Optional(PiSseJsonValue),
  isError: Type.Optional(Type.Boolean({ description: "工具执行是否失败。" })),
  message_count: Type.Optional(Type.Integer({ minimum: 0, description: "agent_end 中的消息数量摘要。" })),
  attempt: Type.Optional(Type.Integer({ minimum: 0, description: "自动重试次数。" })),
  maxAttempts: Type.Optional(Type.Integer({ minimum: 0, description: "自动重试最大次数。" })),
  delayMs: Type.Optional(Type.Integer({ minimum: 0, description: "自动重试等待毫秒数。" })),
  errorMessage: Type.Optional(Type.String({ description: "重试、压缩或运行错误摘要。" })),
  success: Type.Optional(Type.Boolean({ description: "自动重试是否成功。" })),
  finalError: Type.Optional(Type.String({ description: "自动重试结束时的最终错误摘要。" })),
  reason: Type.Optional(Type.String({ enum: ["manual", "threshold", "overflow", "stop", "length", "toolUse", "deferred", "aborted", "error"], description: "压缩、消息结束或错误原因。" })),
  aborted: Type.Optional(Type.Boolean({ description: "上下文压缩是否中止。" })),
  willRetry: Type.Optional(Type.Boolean({ description: "上下文压缩后是否重试。" })),
}, { $id: "PiSseEventData", additionalProperties: true, description: "text/event-stream 中每个 data 行对应的脱敏 JSON。SSE 每条 data 只会包含与其 type 相关的字段。", "x-dynamic-json": true });
const AbortEnvelope = Type.Object({ data: Type.Object({ conversation_id: Type.String({ minLength: 1, description: "会话 ID。" }), aborted: Type.Boolean({ description: "是否发现并终止活动执行；没有运行时为 false。" }) }, { additionalProperties: false }) }, { $id: "AbortEnvelope", description: "终止提示执行的结果。" });
const AuthClaims = Type.Object({
  user_id: Type.String({ minLength: 1, description: "成员账号 ID。" }),
  tenant_id: Type.String({ minLength: 1, description: "Agent 成功身份必含非空企业 ID；不适用于 Operator 平台身份。", examples: ["tenant-1"] }),
  roles: Type.Array(Type.String({ minLength: 1, description: "角色名称。" }), { description: "账号角色列表。" }),
  iss: Type.Optional(Type.String({ description: "JWT issuer。" })),
  aud: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }))], { description: "JWT audience。" })),
  exp: Type.Optional(Type.Integer({ minimum: 0, description: "过期时间（Unix 秒）。" })),
}, { $id: "AuthClaims", additionalProperties: false, description: "当前登录身份声明；不包含密码或其他凭据。" });
const AuthResult = Type.Object({ token: Type.String({ minLength: 1, readOnly: true, description: "短期 access token；用于后续 Authorization: Bearer 请求。" }), claims: Type.Ref("AuthClaims") }, { $id: "AuthResult", additionalProperties: false, description: "登录或密码重置结果。" });
const AuthResultEnvelope = Type.Object({ data: Type.Ref("AuthResult") }, { $id: "AuthResultEnvelope", description: "认证结果响应。" });
const TenantResolution = Type.Object({ tenant_id: Type.String({ minLength: 1, description: "解析出的企业租户 ID；仅返回租户标识。" }) }, { $id: "TenantResolution", additionalProperties: false, description: "企业租户解析结果。" });
const TenantResolutionEnvelope = Type.Object({ data: Type.Ref("TenantResolution") }, { $id: "TenantResolutionEnvelope", description: "租户解析响应。" });
const PingEnvelope = Type.Object({ data: Type.Object({ pong: Type.Boolean({ description: "固定存活探针结果。" }) }, { additionalProperties: false }) }, { $id: "PingEnvelope" });
const ClaimsEnvelope = Type.Object({ data: Type.Ref("AuthClaims") }, { $id: "ClaimsEnvelope" });
const ModelPolicy = Type.Object({
  model: Type.Optional(Type.String({ description: "模型标识。" })),
  provider_ref: Type.Optional(Type.String({ description: "平台 Provider 引用。" })),
  thinking_level: Type.Optional(Type.Ref("ThinkingLevel")),
}, { $id: "AgentModelPolicy", additionalProperties: false, description: "员工模型策略；不包含上游凭据。" });
const SkillSigningKeyMetadata = Type.Object({
  key_id: Type.String({ minLength: 1, description: "签名公钥标识。" }),
  public_key: Type.String({ minLength: 1, description: "Ed25519 公钥；仅用于验证已签名技能包。" }),
  algorithm: Type.Literal("Ed25519", { description: "签名算法。" }),
  status: Type.Union([
    Type.Literal("current", { description: "当前生效密钥。" }),
    Type.Literal("next", { description: "待切换密钥。" }),
    Type.Literal("revoked", { description: "已撤销密钥。" }),
    Type.Literal("expired", { description: "已过期密钥。" }),
  ], { description: "密钥生命周期状态。" }),
  not_before: Type.Optional(Type.Union([Type.String({ format: "date-time", description: "密钥生效时间。" }), Type.Null()])),
  expires_at: Type.Optional(Type.Union([Type.String({ format: "date-time", description: "密钥过期时间。" }), Type.Null()])),
  revoked_at: Type.Optional(Type.Union([Type.String({ format: "date-time", description: "密钥撤销时间。" }), Type.Null()])),
}, { $id: "SkillSigningKeyMetadata", additionalProperties: false, description: "技能签名公钥元数据；不包含私钥。" });
const ExpertProjection = Type.Object({
  ...EmployeeDisplayProperties,
  employee_id: Type.String({ description: "员工/专家 ID。" }), tenant_id: Type.String({ description: "企业租户 ID。" }), member_id: Type.Optional(Type.String({ description: "成员 ID。" })), version: Type.String({ description: "配置版本。" }), handle: Type.String({ description: "用于 @提及的稳定句柄。" }), display_name: Type.String({ description: "展示名称。" }), revoked: Type.Boolean({ description: "是否已撤销授权。" }), synced_at: Type.String({ format: "date-time", description: "同步时间。" }), model_policy: Type.Optional(Type.Ref("AgentModelPolicy")), execution_policy: Type.Optional(JsonObject), tools: Type.Array(Type.String(), { description: "允许使用的工具。" }), skills: Type.Array(Type.String(), { description: "技能引用。" }), skill_refs: Type.Optional(Type.Array(Type.String(), { description: "兼容技能引用字段。" })), knowledge_refs: Type.Optional(Type.Array(Type.String(), { description: "知识引用。" })), connector_refs: Type.Optional(Type.Array(Type.String(), { description: "连接器引用。" })), memory_policy: Type.Optional(JsonObject), persona: Type.Optional(Type.String({ description: "员工人设。" })), status: Type.Optional(Type.String({ description: "员工生命周期状态。" })), avatar_url: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "头像 URL。" })), skill_signing_keys: Type.Optional(Type.Array(Type.Ref("SkillSigningKeyMetadata"), { description: "技能签名公钥列表；不包含私钥。" })),
}, { $id: "ExpertProjection", additionalProperties: true, description: "Manager 授权给当前成员的专家投影；未知扩展字段由 Manager 配置透传，但不包含凭据。", "x-dynamic-json": true });
const SolutionProjection = Type.Object({ solution_instance_id: Type.String({ description: "方案实例 ID。" }), solution_id: Type.Optional(Type.String({ description: "Operator 方案模板 ID。" })), display_name: Type.String({ description: "方案展示名称。" }), description: Type.Optional(Type.String({ description: "方案描述。" })), icon: Type.Optional(Type.String({ description: "方案图标。" })), tags: Type.Optional(Type.Array(Type.String(), { description: "方案标签。" })), version: Type.String({ description: "方案配置版本。" }), status: Type.Optional(Type.String({ description: "方案状态。" })), coordinator_instructions: Type.Optional(Type.String({ description: "方案协调说明。" })), workflow_skill_ref: Type.Optional(JsonObject), output_requirements: Type.Optional(Type.String({ description: "方案交付要求。" })), config_version: Type.Optional(Type.Integer({ minimum: 1, description: "方案配置版本号。" })), coordinator_employee_id: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "协调员工 ID。" })), expert_employee_ids: Type.Optional(Type.Array(Type.String(), { description: "方案内专家 ID。" })), tenant_id: Type.Optional(Type.String({ description: "企业租户 ID。" })), member_id: Type.Optional(Type.String({ description: "成员 ID。" })) }, { $id: "SolutionProjection", additionalProperties: true, description: "Manager 授权给当前成员的方案投影。", "x-dynamic-json": true });
const SnapshotProjection = Type.Object({ employee_id: Type.String({ minLength: 1, description: "员工 ID。" }), version: Type.String({ minLength: 1, description: "员工配置版本。" }), snapshot_version: Type.String({ minLength: 1, description: "执行快照版本。" }), display_name: Type.String({ minLength: 1, description: "员工展示名称。" }), tenant_id: Type.Optional(Type.String({ description: "企业租户 ID。" })), member_id: Type.Optional(Type.String({ description: "成员 ID。" })), persona: Type.Optional(Type.String({ description: "员工人设。" })), model_policy: Type.Optional(Type.Ref("AgentModelPolicy")), execution_policy: Type.Optional(JsonObject), tools: Type.Optional(Type.Array(Type.String({ description: "工具名称。" }), { description: "快照允许的工具。" })), skills: Type.Optional(Type.Array(Type.String({ description: "技能引用。" }), { description: "规范技能引用；该字段一旦出现（包括 []）即为权威，不读取 skill_refs。" })), skill_refs: Type.Optional(Type.Array(Type.String({ description: "技能引用。" }), { description: "旧本地投影兼容字段；仅当规范 skills 字段缺失时使用，不能覆盖显式 skills=[]。" })), knowledge_refs: Type.Optional(Type.Array(Type.String({ description: "知识引用。" }), { description: "知识引用。" })), connector_refs: Type.Optional(Type.Array(Type.String({ description: "连接器引用。" }), { description: "连接器引用。" })), memory_policy: Type.Optional(JsonObject), skill_signing_keys: Type.Optional(Type.Array(Type.Ref("SkillSigningKeyMetadata"), { description: "技能签名公钥列表；不包含私钥。" })), tool_policy: Type.Optional(Type.Object({ allowed_tools: Type.Array(Type.String({ description: "工具名称。" }), { description: "允许的工具名称。" }) }, { additionalProperties: false, description: "快照工具白名单。" })) }, { $id: "SnapshotProjection", additionalProperties: true, description: "冻结的员工执行快照；skills 是 presence-aware 的规范技能字段（包括 []），skill_refs 仅在 skills 缺失时兼容旧投影；用于离线执行和授权校验。", "x-dynamic-json": true });
const ExpertListEnvelope = Type.Object({ data: Type.Array(Type.Ref("ExpertProjection")), page: Type.Ref("Page") }, { $id: "ExpertListEnvelope" });
const SolutionListEnvelope = Type.Object({ data: Type.Array(Type.Ref("SolutionProjection")), page: Type.Ref("Page") }, { $id: "SolutionListEnvelope" });
const SnapshotListEnvelope = Type.Object({ data: Type.Array(Type.Ref("SnapshotProjection")), page: Type.Ref("Page") }, { $id: "SnapshotListEnvelope" });
const SkillReadiness = Type.Object({
  ref: Type.String({ minLength: 1, description: "技能引用。" }),
  status: Type.Ref("ReadinessState"),
  reason: Type.Optional(Type.String({ description: "技能不可用或降级原因。" })),
  version: Type.Optional(Type.String({ description: "已解析的技能版本。" })),
}, { $id: "SkillReadiness", additionalProperties: false, description: "单个技能的本地就绪状态。" });
const CapabilityReadiness = Type.Object({
  kind: Type.Union([
    Type.Literal("knowledge", { description: "企业知识能力。" }),
    Type.Literal("memory", { description: "员工记忆能力。" }),
    Type.Literal("connector", { description: "连接器能力。" }),
  ], { description: "能力类型。" }),
  refs: Type.Array(Type.String({ minLength: 1, description: "能力引用。" }), { description: "能力引用列表。" }),
  status: Type.Ref("ReadinessState"),
  reason: Type.Optional(Type.String({ description: "能力不可用或降级原因。" })),
}, { $id: "CapabilityReadiness", additionalProperties: false, description: "单类外部能力的本地就绪状态。" });
const ExpertReadiness = Type.Object({
  employee_id: Type.String({ minLength: 1, description: "员工 ID。" }),
  display_name: Type.String({ description: "员工展示名称。" }),
  handle: Type.String({ description: "员工句柄。" }),
  available: Type.Boolean({ description: "综合 runtime、provider、生命周期及所有必需签名技能的实际缓存/加载状态后是否可执行。" }),
  runtime: Type.Ref("ReadinessState"),
  provider: Type.Ref("ReadinessState"),
  skills: Type.Array(Type.Ref("SkillReadiness"), { description: "已授权技能的就绪状态。" }),
  capabilities: Type.Array(Type.Ref("CapabilityReadiness"), { description: "知识、记忆和连接器能力的就绪状态。" }),
  reasons: Type.Array(Type.String(), { description: "不可用或降级原因列表。" }),
}, { $id: "ExpertReadiness", additionalProperties: false, description: "单个专家的本地执行就绪状态；专家不存在时仍返回 200 和 available=false。" });
const ExpertReadinessEnvelope = Type.Object({ data: Type.Ref("ExpertReadiness") }, { $id: "ExpertReadinessEnvelope", description: "单个专家就绪状态响应。" });
const ReadinessEnvelope = Type.Object({ data: Type.Object({ runtime: Type.Ref("ReadinessState"), runtime_reason: Type.Optional(Type.String({ description: "runtime 不可用原因。" })), experts: Type.Array(Type.Ref("ExpertReadiness"), { description: "各授权专家状态。" }) }, { additionalProperties: false }) }, { $id: "ReadinessEnvelope", description: "Agent runtime 与已装载专家的就绪状态响应。" });
const GrantSyncEnvelope = Type.Object({ data: Type.Object({ ok: Type.Boolean({ const: true, description: "同步是否成功；成功响应固定为 true。" }), upserted: Type.Integer({ minimum: 0, description: "写入或更新的投影数量。" }), revoked: Type.Integer({ minimum: 0, description: "撤销并移除的投影数量。" }) }, { additionalProperties: false }) }, { $id: "GrantSyncEnvelope", description: "授权同步结果；投影正文通过后续本地 grants 接口读取。" });
const UsageFlushEnvelope = Type.Object({ data: Type.Object({ sent: Type.Array(Type.String({ minLength: 1, description: "摘要 ID。" }), { description: "已成功上报的摘要 ID。" }), failed: Type.Array(Type.String({ minLength: 1, description: "摘要 ID。" }), { description: "本次上报失败、仍留在本地 outbox 的摘要 ID。" }) }, { additionalProperties: false }) }, { $id: "UsageFlushEnvelope", description: "用量 outbox 刷新结果；失败项不会被误标记为成功。" });
const OrgTreeNode = Type.Object({
  role_title: EmployeeDisplayProperties.role_title,
  id: Type.String({ minLength: 1, description: "组织节点 ID。" }),
  name: Type.String({ description: "组织节点名称。" }),
  type: Type.Union([
    Type.Literal("department", { description: "部门节点。" }),
    Type.Literal("employee", { description: "员工节点。" }),
  ], { description: "节点类型。" }),
  parent_id: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "父节点 ID。" })),
  status: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "节点状态。" })),
  avatar_url: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "员工头像引用。" })),
  children: Type.Array(Type.Ref("OrgTreeNode"), { description: "递归子组织节点。" }),
}, { $id: "OrgTreeNode", additionalProperties: false, description: "递归组织树投影。" });
const OrgTreeEnvelope = Type.Object({ data: Type.Ref("OrgTreeNode") }, { $id: "OrgTreeEnvelope" });
const OfficeSceneEnvelope = Type.Object({
  data: Type.Object({
    employees: Type.Array(Type.Object({
      ...EmployeeDisplayProperties,
      employee_id: Type.String({ minLength: 1, description: "员工 ID。" }),
      display_name: Type.String({ description: "员工展示名称。" }),
      status: Type.Union([
        Type.Literal("working", { description: "当前有提示正在执行。" }),
        Type.Literal("ready", { description: "已授权且当前空闲。" }),
        Type.Literal("offline", { description: "已撤销、未激活或不可用。" }),
      ], { description: "办公状态。" }),
      task: Type.Union([Type.String(), Type.Null()], { description: "当前任务标题；非 working 时通常为 null。" }),
      avatar_url: Type.Union([Type.String(), Type.Null()], { description: "头像 URL。" }),
      last_activity_at: Type.Optional(Type.Union([Type.String({ format: "date-time", description: "最近活动时间。" }), Type.Null()])),
      last_status: Type.Optional(Type.Union([
        Type.Literal("working"), Type.Literal("completed"), Type.Literal("waiting"),
        Type.Literal("error"), Type.Literal("idle"), Type.Literal("offline"),
      ], { description: "最近一次活动状态。" })),
      last_task: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "最近关联的会话任务标题。" })),
    }, { additionalProperties: false, description: "单个已装载员工的办公状态。" })),
    summary: Type.Object({
      total: Type.Integer({ minimum: 0, description: "员工总数。" }),
      working: Type.Integer({ minimum: 0, description: "工作中数量。" }),
      ready: Type.Integer({ minimum: 0, description: "就绪数量。" }),
      offline: Type.Integer({ minimum: 0, description: "离线数量。" }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
}, { $id: "OfficeSceneEnvelope", description: "本地办公场景响应。" });
const OfficeFeedEnvelope = Type.Object({
  data: Type.Object({
    events: Type.Array(Type.Object({
      type: Type.Literal("conversation_schedule", { description: "定时会话摘要事件。" }),
      conversation_id: Type.String({ minLength: 1, description: "会话 ID。" }),
      title: Type.String({ description: "事件标题。" }),
      schedule: Type.Union([Type.Ref("ConversationSchedule"), Type.Null()], { description: "调度配置。" }),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
}, { $id: "OfficeFeedEnvelope", description: "本地办公动态响应；events 仅包含会话调度摘要，不包含实时 Pi 事件。" });
const GoneEnvelope = Type.Object({ data: Type.Object({ removed: Type.Boolean({ description: "接口已移除。" }), replacement: Type.String({ description: "替代接口说明。" }) }, { additionalProperties: false }) }, { $id: "GoneEnvelope", description: "已移除接口的替代说明。" });
const PromptImage = Type.Object({
  type: Type.Literal("image", { description: "图片内容类型；固定为 image。" }),
  data: Type.String({ minLength: 1, maxLength: MAX_BASE64_FILE_CHARS, contentEncoding: "base64", description: "规范 base64 图片数据；解码后单张不超过 5 MiB。" }),
  mimeType: Type.String({ enum: IMAGE_MIME_TYPES, description: "图片 MIME 类型；必须与图片文件签名一致。" }),
}, { $id: "PromptImage", additionalProperties: false, description: "提交给 Pi 的内联图片；最多 8 张，图片字节不会通过事件返回。" });
const PromptRequest = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 200_000, description: "提交给当前员工的文本提示。" }),
  images: Type.Optional(Type.Array(Type.Ref("PromptImage"), { maxItems: MAX_PROMPT_IMAGES, description: "最多 8 张内联图片；单张解码后不超过 5 MiB，总大小不超过 20 MiB。" })),
  attachment_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256, description: "本地附件 ID；只有图片附件会作为 Pi 图片输入，其余文件保持本地元数据。" }), { maxItems: MAX_PROMPT_IMAGES, uniqueItems: true, description: "已上传本地附件 ID；最多 8 个且不能重复。" })),
  mentions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128, description: "被 @提及的员工句柄；仅群聊允许。" }), { maxItems: 16, description: "群聊中的员工提及；最多 16 个。重复句柄会合并。" })),
}, { $id: "PromptRequest", additionalProperties: false, description: "向本地会话提交提示的请求。" });
const PromptAccepted = Type.Object({ conversation_id: Type.String({ minLength: 1, description: "会话 ID。" }), accepted: Type.Boolean({ const: true, description: "是否已接受执行；成功响应固定为 true。" }), state: Type.Union([Type.Literal("accepted", { description: "本次请求已接收，后台执行尚未完成。" }), Type.Literal("completed", { description: "相同 Idempotency-Key 已完成，返回幂等收据。" })], { description: "幂等收据状态。" }), idempotency_key: Type.String({ minLength: 1, maxLength: 256, description: "本次请求使用的幂等键。" }) }, { $id: "PromptAccepted", description: "提示提交收据；202 表示已接收或幂等重放。" });
const PromptAcceptedEnvelope = Type.Object({ data: Type.Ref("PromptAccepted") }, { $id: "PromptAcceptedEnvelope", description: "提示提交成功响应。" });
const LocalFileUpload = Type.Object({
  filename: Type.String({ minLength: 1, maxLength: MAX_LOCAL_FILE_NAME, pattern: "^[^\\x00-\\x1F\\x7F/\\\\]+$", description: "安全的文件名，不含路径分隔符或控制字符。" }),
  mime_type: Type.String({ enum: FILE_MIME_TYPES, description: "文件 MIME 类型；必须属于 Agent 支持的类型集合。" }),
  data: Type.String({ minLength: 1, maxLength: MAX_BASE64_FILE_CHARS, contentEncoding: "base64", description: "规范 base64 文件内容；解码后不超过 5 MiB。" }),
}, { $id: "LocalFileUpload", additionalProperties: false, description: "本地附件/产物上传请求；单文件最大 5 MiB，文件内容只保存在本机。" });
const AudioTranscriptionRequest = Type.Object({
  filename: Type.String({ minLength: 1, maxLength: MAX_LOCAL_FILE_NAME, description: "录音文件名，不含路径分隔符。" }),
  mime_type: Type.String({ minLength: 1, maxLength: 128, enum: AUDIO_MIME_TYPES, description: "录音 MIME 类型；允许带 codec 参数，服务端按主 MIME 类型校验。" }),
  data: Type.String({ minLength: 1, maxLength: MAX_BASE64_FILE_CHARS, contentEncoding: "base64", description: "规范 base64 录音内容；解码后不超过 5 MiB。" }),
}, { $id: "AudioTranscriptionRequest", additionalProperties: false, description: "本地语音转写请求；Agent 会使用当前成员企业的受限 ASR 配置。" });
const AudioTranscriptionResponse = Type.Object({
  text: Type.String({ description: "语音识别文本。" }),
  duration: Type.Optional(Type.Number({ minimum: 0, description: "音频时长（秒）。" })),
}, { $id: "AudioTranscriptionResponse", additionalProperties: false, description: "语音识别结果。" });
const AudioTranscriptionEnvelope = Type.Object({ data: Type.Ref("AudioTranscriptionResponse") }, { $id: "AudioTranscriptionEnvelope", description: "语音识别响应。" });
const LocalFileMetadata = Type.Object({
  id: Type.String({ minLength: 1, description: "文件 ID。" }), conversation_id: Type.String({ minLength: 1, description: "所属会话 ID。" }), tenant_id: Type.String({ minLength: 1, description: "企业租户 ID。" }), member_id: Type.String({ minLength: 1, description: "所属成员 ID。" }), kind: Type.String({ enum: ["attachment", "artifact"], description: "文件类型。" }), filename: Type.String({ minLength: 1, maxLength: MAX_LOCAL_FILE_NAME, description: "安全文件名。" }), mime_type: Type.String({ enum: FILE_MIME_TYPES, description: "文件 MIME 类型。" }), byte_size: Type.Integer({ minimum: 0, maximum: MAX_LOCAL_FILE_BYTES, description: "文件字节数；单文件最大 5 MiB。" }), sha256: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$", description: "文件内容 SHA-256 摘要。" }), created_at: Type.String({ format: "date-time", description: "创建时间（ISO 8601 UTC）。" }), referenced_at: Type.Optional(Type.Union([Type.String({ format: "date-time", description: "被提示引用的时间。" }), Type.Null()], { description: "被提示引用的时间；未引用时为 null。" })),
}, { $id: "LocalFileMetadata", description: "本地文件元数据；响应不包含文件内容。" });
const LocalFileEnvelope = Type.Object({ data: Type.Ref("LocalFileMetadata") }, { $id: "LocalFileEnvelope", description: "单个本地文件响应。" });
const Page = Type.Object({ next_cursor: Type.Union([Type.String({ minLength: 1, description: "下一页游标。" }), Type.Null()], { description: "下一页游标；无下一页时为 null。" }), has_more: Type.Boolean({ description: "是否还有更多。" }) }, { $id: "Page", description: "分页信息；当前文件、授权和市场列表返回 null 游标表示一次性结果。" });
const LocalFileListEnvelope = Type.Object({ data: Type.Array(Type.Ref("LocalFileMetadata"), { description: "文件元数据列表。" }), page: Type.Ref("Page") }, { $id: "LocalFileListEnvelope", description: "本地文件列表响应。" });
const LocalFileDeleteEnvelope = Type.Object({ data: Type.Object({ deleted: Type.Boolean({ const: true, description: "是否删除成功；成功响应固定为 true。" }), id: Type.String({ minLength: 1, description: "删除的文件 ID。" }) }, { additionalProperties: false }) }, { $id: "LocalFileDeleteEnvelope", description: "本地文件删除结果。" });
const MarketplaceTemplate = Type.Object({
  template_id: Type.String({ minLength: 1, description: "模板 ID。" }),
  display_name: Type.String({ description: "模板展示名称。" }),
  description: Type.Union([Type.String(), Type.Null()], { description: "上游模板原有描述；未提供为 null。", examples: ["研究与报告整理", null] }),
  platform_skill_refs: Type.Union([Type.Array(Type.Object({
    skill_id: Type.String({ minLength: 1, description: "平台技能 ID。" }),
    version: Type.String({ minLength: 1, description: "固定技能版本。" }),
    content_hash: Type.String({ minLength: 1, description: "固定内容哈希。" }),
  }, { additionalProperties: false }), { description: "上游合法固定引用；仅返回 ID/版本/哈希，不返回技能包正文或企业绑定。" }), Type.Null()], { description: "现代模板固定技能列表，[] 表示明确无技能；旧目录未提供时为 null，不从旧 skill_ids 猜版本。" }),
  category: Type.String({ description: "模板分类。" }),
  model_name: Type.String({ description: "默认模型名称；可能为空字符串表示尚未配置。" }),
  skills_count: Type.Integer({ minimum: 0, description: "优先按合法 platform_skill_refs 计数（含明确空列表）；旧目录兼容已有计数/skill_ids。" }),
  recruit_count: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], { description: "仅透出上游已记录的招募计数，未提供时为 null；不是本端计算的跨企业商业统计。" }),
  is_recruited: Type.Boolean({ description: "当前企业是否已有该模板的有效招募实例。" }),
  tags: Type.Array(Type.String({ description: "模板标签。" }), { description: "模板标签。" }),
  avatar_url: Type.Union([Type.String(), Type.Null()], { description: "头像 URL；未配置时为 null。" }),
}, { $id: "MarketplaceTemplate", additionalProperties: false, description: "Manager 目录受控摘要，无 usage_stats/price_tier 或招募前企业能力要求。名称/分类筛选由客户端完成，无服务端市场搜索或翻页。" });
const MarketplaceTemplateEnvelope = Type.Object({ data: Type.Ref("MarketplaceTemplate") }, { $id: "MarketplaceTemplateEnvelope", description: "单个人才市场模板响应。" });
const MarketplaceTemplateListEnvelope = Type.Object({ data: Type.Array(Type.Ref("MarketplaceTemplate"), { description: "可见模板列表。" }), page: Type.Ref("Page") }, { $id: "MarketplaceTemplateListEnvelope", description: "人才市场模板列表响应；当前 page 游标固定为空。" });
const UsageSummary = Type.Object({ schema_version: Type.Literal("1", { description: "摘要 schema 版本。" }), summary_id: Type.String({ minLength: 1, description: "摘要幂等 ID。" }), tenant_id: Type.String({ minLength: 1, description: "企业租户 ID。" }), member_id: Type.String({ minLength: 1, description: "成员 ID。" }), employee_id: Type.String({ minLength: 1, description: "员工 ID。" }), window_start: Type.String({ format: "date-time", description: "统计窗口起点（ISO 8601 UTC）。" }), window_end: Type.String({ format: "date-time", description: "统计窗口终点（ISO 8601 UTC）。" }), prompt_count: Type.Integer({ minimum: 0, description: "提示次数。" }), settled_count: Type.Integer({ minimum: 0, description: "已结算次数。" }), error_count: Type.Integer({ minimum: 0, description: "错误次数。" }), input_tokens: Type.Integer({ minimum: 0, description: "输入 token 数。" }), output_tokens: Type.Integer({ minimum: 0, description: "输出 token 数。" }), cache_tokens: Type.Integer({ minimum: 0, description: "缓存 token 数。" }), cost_minor: Type.Integer({ minimum: 0, description: "最小货币单位成本（USD cents）。" }), currency: Type.Literal("USD", { description: "成本币种；固定为 USD。" }), duration_ms_total: Type.Integer({ minimum: 0, description: "总耗时（毫秒）。" }), pricing_version: Type.Union([Type.Integer({ minimum: 1, description: "计价版本。" }), Type.Null()], { description: "计价版本；未知价格时为 null。" }), pricing_status: Type.Union([Type.Literal("known", { description: "价格已知。" }), Type.Literal("unknown", { description: "价格未知。" })], { description: "价格是否可用。" }), run_count: Type.Integer({ minimum: 0, description: "兼容聚合字段：运行次数。" }), token_total: Type.Integer({ minimum: 0, description: "兼容聚合字段：总 token 数。" }), cost_total: Type.Number({ minimum: 0, description: "兼容聚合字段：总成本（USD）。" }), duration_seconds_total: Type.Integer({ minimum: 0, description: "兼容聚合字段：总耗时（秒）。" }) }, { $id: "UsageSummary", additionalProperties: false, description: "脱敏用量摘要；不包含会话正文、工具明细或原始事件。" });
const UsageOutboxItem = Type.Object({ summary_id: Type.String({ minLength: 1, description: "摘要幂等 ID。" }), tenant_id: Type.String({ minLength: 1, description: "企业租户 ID。" }), member_id: Type.String({ minLength: 1, description: "成员 ID。" }), kind: Type.String({ minLength: 1, description: "摘要类型；当前用量摘要为 usage。" }), status: Type.Union([Type.Literal("pending"), Type.Literal("sending"), Type.Literal("sent"), Type.Literal("failed")], { description: "outbox 状态。" }), attempts: Type.Integer({ minimum: 0, description: "已尝试上报次数。" }), last_error: Type.Union([Type.String(), Type.Null()], { description: "最近一次错误；无错误时为 null。" }), created_at: Type.String({ format: "date-time", description: "入队时间（ISO 8601 UTC）。" }), payload: Type.Optional(Type.Ref("UsageSummary")) }, { $id: "UsageOutboxItem", additionalProperties: false, description: "本地用量上报 outbox 项；payload 仅为脱敏聚合摘要。" });
const UsageOutboxListEnvelope = Type.Object({ data: Type.Array(Type.Ref("UsageOutboxItem")), page: Type.Ref("Page") }, { $id: "UsageOutboxListEnvelope" });
const ProblemSchema = Type.Object({ type: Type.String({ description: "错误类型 URI。" }), title: Type.String({ description: "错误标题。" }), status: Type.Integer({ description: "HTTP 状态码。" }), code: Type.String({ description: "机器可读错误码。" }), detail: Type.String({ description: "人类可读错误说明。" }), instance: Type.String({ description: "错误实例或请求关联 ID。" }), request_id: Type.String({ description: "请求关联 ID。" }), errors: Type.Optional(Type.Array(Type.Object({ loc: Type.Array(Type.Union([Type.String(), Type.Integer()]), { description: "错误字段路径。" }), message: Type.String({ description: "字段错误说明。" }), type: Type.String({ description: "校验错误类型。" }) }, { additionalProperties: false }), { description: "字段级错误。" })), meta: Type.Optional(Type.Record(Type.String({ description: "元数据键。" }), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]), { description: "非敏感诊断元数据。" })) }, { $id: "Problem", additionalProperties: false, description: "统一 problem+json 错误。" });
const LOCAL_FILE_DOWNLOAD_CONTENT = Object.fromEntries([...ALLOWED_FILE_MIMES].map((mime) => [mime, { schema: { type: "string", format: "binary", description: `${mime} 文件内容。` } }]));
const OPENAPI_SCHEMAS = [CustomGroupCreateRequest, GroupOrchestration,...WORK_RECORD_SCHEMAS, ...CONVERSATION_READ_SCHEMAS, ConversationSchedule, ConversationScheduleInput, ResolveTenantRequest, AgentLoginRequest, AgentResetPasswordRequest, ConversationMetadata, ConversationCreateRequest, ConversationUpdateRequest, ConversationStateUpdateRequest, ConversationState, ConversationEnvelope, ConversationListEnvelope, ConversationStateOut, ConversationStateEnvelope, ThinkingLevel, ConversationContextOut, ConversationContextEnvelope, ConversationThinkingLevelRequest, GrantSyncRequest, UsageFlushRequest, ConversationDeleteEnvelope, ConversationContentPart, ConversationMessage, ConversationEntry, ConversationEntriesEnvelope, BoundedJsonValue, PiSseToolCall, PiSseAssistantMessageEvent, PiSseEventData, AbortEnvelope, AuthClaims, AuthResult, AuthResultEnvelope, TenantResolution, TenantResolutionEnvelope, PingEnvelope, ClaimsEnvelope, ModelPolicy, SkillSigningKeyMetadata, ExpertProjection, SolutionProjection, SnapshotProjection, ExpertListEnvelope, SolutionListEnvelope, SnapshotListEnvelope, ReadinessState, SkillReadiness, CapabilityReadiness, ExpertReadiness, ReadinessEnvelope, ExpertReadinessEnvelope, GrantSyncEnvelope, UsageFlushEnvelope, OrgTreeNode, OrgTreeEnvelope, OfficeSceneEnvelope, OfficeFeedEnvelope, GoneEnvelope, PromptImage, PromptRequest, PromptAccepted, PromptAcceptedEnvelope, LocalFileUpload, AudioTranscriptionRequest, AudioTranscriptionResponse, AudioTranscriptionEnvelope, LocalFileMetadata, LocalFileEnvelope, Page, LocalFileListEnvelope, LocalFileDeleteEnvelope, MarketplaceTemplate, MarketplaceTemplateEnvelope, MarketplaceTemplateListEnvelope, UsageSummary, UsageOutboxItem, UsageOutboxListEnvelope, ProblemSchema] as const;

const PI_EVENT_STREAM_DESCRIPTION = "订阅当前会话的本地 Pi 实时事件（SSE）；事件字段见 [PiSseEventData](#/components/schemas/PiSseEventData)。";

const PI_EVENT_STREAM_EXAMPLES = {
  thinking: {
    summary: "思考增量事件",
    value: [
      "id: employee-1:assistant-1",
      "event: pi",
      'data: {"type":"message_update","conversation_id":"conversation-1","message":{"role":"assistant","content":[{"type":"thinking","thinking":"先分析用户请求"}]},"assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"先分析用户请求"}}',
      "",
    ].join("\n"),
  },
  toolCall: {
    summary: "模型发起工具调用事件",
    value: [
      "id: employee-1:assistant-1",
      "event: pi",
      'data: {"type":"message_update","conversation_id":"conversation-1","message":{"role":"assistant","content":[{"type":"toolCall","id":"call-1","name":"bash","arguments":{"command":"printf \'hello\'"}}]},"assistantMessageEvent":{"type":"toolcall_end","contentIndex":0,"toolCall":{"type":"toolCall","id":"call-1","name":"bash","arguments":{"command":"printf \'hello\'"}}}}',
      "",
    ].join("\n"),
  },
  toolExecution: {
    summary: "普通工具执行事件",
    value: [
      "id: employee-1:call-1",
      "event: pi",
      'data: {"type":"tool_execution_start","conversation_id":"conversation-1","toolCallId":"call-1","toolName":"bash","args":{"command":"printf \'hello\'"}}',
      "",
      "id: employee-1:call-1-end",
      "event: pi",
      'data: {"type":"tool_execution_end","conversation_id":"conversation-1","toolCallId":"call-1","toolName":"bash","result":{"text":"hello"},"isError":false}',
      "",
    ].join("\n"),
  },
  todoUpdate: {
    summary: "todo_update 待办列表事件",
    value: [
      "id: employee-1:todo-1",
      "event: pi",
      'data: {"type":"tool_execution_start","conversation_id":"conversation-1","toolCallId":"todo-1","toolName":"todo_update","tool_kind":"todo","args":{"items":[{"id":"task-1","title":"完成调研","status":"in_progress"}]}}',
      "",
    ].join("\n"),
  },
  lifecycle: {
    summary: "Agent 生命周期事件",
    value: [
      "id: conversation-1:1",
      "event: pi",
      'data: {"type":"agent_start","conversation_id":"conversation-1","source_employee_id":"employee-1","source_role":"participant"}',
      "",
    ].join("\n"),
  },
} as const;

const EXAMPLE_PAGE = { next_cursor: null, has_more: false };
const EXAMPLE_SCHEDULE = {
  schedule_id: "schedule-1", revision: 1, enabled: true, at: "2026-09-01T09:00:00.000Z",
  one_shot: true, overlap: "skip", misfire: "skip", prompt_template: "整理今日工作摘要",
};
const EXAMPLE_CONVERSATION = {
  id: "conversation-1", title: "今日工作摘要", kind: "private", labels: ["daily"], state: "active",
  entry_employee_id: "employee-1", coordinator_employee_id: null, solution_instance_id: null,
  tenant_id: "tenant-1", member_id: "member-1", schedule: null, permission_mode: "read-only",
  last_read_entry_id: null, last_preview: null, unread_count: 0, created_at: "2026-09-01T08:00:00.000Z", updated_at: "2026-09-01T08:01:00.000Z",
};
const EXAMPLE_FILE = {
  id: "file-1", conversation_id: "conversation-1", tenant_id: "tenant-1", member_id: "member-1",
  kind: "attachment", filename: "notes.md", mime_type: "text/markdown", byte_size: 5,
  sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  created_at: "2026-09-01T08:02:00.000Z", referenced_at: null,
};
const EXAMPLE_EXPERT = {
  employee_id: "employee-1", tenant_id: "tenant-1", member_id: "member-1", version: "v1",
  handle: "researcher", display_name: "研究助手", revoked: false, synced_at: "2026-09-01T08:00:00.000Z",
  model_policy: { model: "model-1", provider_ref: "provider-1", thinking_level: "medium" },
  tools: ["todo_update"], skills: ["research"], status: "active", avatar_url: null,
  role_title: "研究分析师", department_ids: ["department-research", "department-sales"],
};
const EXAMPLE_SOLUTION = {
  solution_instance_id: "solution-1", solution_id: "solution-template-1", display_name: "研究方案",
  description: "市场研究协作方案", icon: "research", tags: ["research"], version: "v1",
  status: "active", coordinator_instructions: "先由协调员拆解任务", output_requirements: "输出带引用的摘要",
  config_version: 1, coordinator_employee_id: "employee-1", expert_employee_ids: ["employee-1"],
  tenant_id: "tenant-1", member_id: "member-1",
};
const EXAMPLE_SNAPSHOT = {
  employee_id: "employee-1", version: "v1", snapshot_version: "snapshot-1", display_name: "研究助手",
  tenant_id: "tenant-1", member_id: "member-1", persona: "负责研究和摘要", tools: ["todo_update"],
  skills: ["research@v1"], skill_refs: ["legacy-research@old"], knowledge_refs: [], connector_refs: [],
  tool_policy: { allowed_tools: ["todo_update"] },
};
const EXAMPLE_READINESS = {
  employee_id: "employee-1", display_name: "研究助手", handle: "researcher", available: true,
  runtime: "ready", provider: "ready", skills: [{ ref: "research@v1", status: "ready", version: "v1" }],
  capabilities: [{ kind: "knowledge", refs: ["workspace-1"], status: "ready" }], reasons: [],
};
const EXAMPLE_USAGE_SUMMARY = {
  schema_version: "1", summary_id: "summary-1", tenant_id: "tenant-1", member_id: "member-1", employee_id: "employee-1",
  window_start: "2026-09-01T08:00:00.000Z", window_end: "2026-09-01T09:00:00.000Z", prompt_count: 1,
  settled_count: 1, error_count: 0, input_tokens: 100, output_tokens: 40, cache_tokens: 0, cost_minor: 2,
  currency: "USD", duration_ms_total: 1200, pricing_version: 1, pricing_status: "known", run_count: 1,
  token_total: 140, cost_total: 0.02, duration_seconds_total: 2,
};

type OpenApiExample = { summary: string; value: unknown };
type OpenApiOperationDocs = {
  description?: string;
  request?: Record<string, OpenApiExample>;
  responses?: Record<string, { description?: string; examples?: Record<string, OpenApiExample> }>;
};
const MANAGER_BACKED_OPERATION_IDS = new Set([
  "resolveTenantByAccount", "login", "resetPassword", "transcribeAudio", "getConversationContext",
  "updateConversationContext", "setConversationThinkingLevel", "promptConversation", "syncGrants",
  "flushUsage", "listMarketplaceTemplates", "getMarketplaceTemplate", "orgTree",
]);
const OPENAPI_PARAMETER_EXAMPLES: Record<string, unknown> = {
  conversation_id: "conversation-1", attachment_id: "file-1", artifact_id: "artifact-1", employee_id: "employee-1",
  template_id: "template-1", knowledge_base_id: "legacy-knowledge-base", resource_id: "resource-1", kind: "document",
  after: "employee-1:assistant-1", cursor: "page_v1.opaque", limit: 50, entry_ref: "entry_v1_opaque",
  "Idempotency-Key": "prompt-1", "Last-Event-ID": "employee-1:assistant-1",
};
const OPENAPI_OPERATION_DOCS: Record<string, OpenApiOperationDocs> = {
  ...CONVERSATION_READ_DOCS,
  ...WORK_RECORD_DOCS,
  healthz: { responses: { "200": { description: "Agent 存活时返回就绪状态。", examples: { ok: { summary: "存活", value: { data: { status: "ok" } } } } } } },
  metrics: { responses: { "200": { description: "Prometheus 文本指标。", examples: { metrics: { summary: "指标文本", value: "# TYPE aiteam_agent_http_requests_total counter\\naiteam_agent_http_requests_total 12\\n" } } } } },
  readyz: { responses: {
    "200": { description: "本地依赖全部就绪。", examples: { ready: { summary: "已就绪", value: { data: { ready: true } } } } },
    "503": { description: "本地依赖未就绪；仍返回 readiness envelope。", examples: { blocked: { summary: "未就绪", value: { data: { ready: false } } } } },
  } },
  openapi: { responses: { "200": { description: "OpenAPI 3.1 文档对象。", examples: { document: { summary: "文档对象", value: { openapi: "3.1.0", info: { title: "AI Team Agent Service", version: "0.1.0" }, paths: {} } } } } } },
  redoc: { responses: { "200": { description: "ReDoc HTML 页面。", examples: { html: { summary: "HTML", value: "<!doctype html><title>AI Team Agent API</title>" } } } } },
  redocBundle: { responses: { "200": { description: "ReDoc JavaScript 资源。", examples: { javascript: { summary: "JavaScript", value: "(() => {})();" } } } } },
  resolveTenantByAccount: { request: { account: { summary: "账号", value: { account: "13800000000" } } }, responses: { "200": { description: "仅返回解析出的租户标识。", examples: { resolved: { summary: "租户解析成功", value: { data: { tenant_id: "tenant-1" } } } } } } },
  login: { request: { credentials: { summary: "登录凭据", value: { tenant_id: "tenant-1", account: "13800000000", password: "••••••••" } } }, responses: { "200": { description: "返回本地短期 access token 和身份声明。", examples: { loggedIn: { summary: "登录成功", value: { data: { token: "eyJ...redacted", claims: { user_id: "member-1", tenant_id: "tenant-1", roles: ["member"], exp: 1790000000 } } } } } } } },
  resetPassword: { request: { reset: { summary: "密码重置", value: { tenant_id: "tenant-1", account: "13800000000", old_password: "••••••••", new_password: "••••••••" } } }, responses: { "200": { description: "返回重置后新的本地 access token。", examples: { reset: { summary: "重置成功", value: { data: { token: "eyJ...redacted", claims: { user_id: "member-1", tenant_id: "tenant-1", roles: ["owner"], exp: 1790000000 } } } } } } } },
  transcribeAudio: { request: { audio: { summary: "录音文件", value: { filename: "recording.webm", mime_type: "audio/webm", data: "YXVkaW8=" } } }, responses: { "200": { description: "返回 ASR 文本和可选时长。", examples: { transcript: { summary: "转写成功", value: { data: { text: "你好，世界", duration: 1.2 } } } } } } },
  ping: { responses: { "200": { description: "固定存活探针结果。", examples: { pong: { summary: "存活", value: { data: { pong: true } } } } } } },
  whoami: { responses: { "200": { description: "当前 access token 的身份声明。", examples: { identity: { summary: "当前身份", value: { data: { user_id: "member-1", tenant_id: "tenant-1", roles: ["member"] } } } } } } },
  listConversations: { request: { limit: { summary: "返回条数", value: 50 }, cursor: { summary: "分页游标", value: "conversation-previous" } }, responses: { "200": { description: "本地会话列表和分页信息。", examples: { list: { summary: "会话列表", value: { data: [EXAMPLE_CONVERSATION], page: EXAMPLE_PAGE } } } } } },
  createCustomGroup: { request: {
    automatic: { summary: "自选成员自动编排", value: { id: "group-client-1", title: "课程协作", description: "根据客户需求协同完成课程方案", member_employee_ids: ["employee-1", "employee-2"], coordinator_employee_id: "employee-1", orchestration: { mode: "auto" } } },
    custom: { summary: "自定义协作提示词", value: { id: "group-client-2", title: "课程协作", member_employee_ids: ["employee-1", "employee-2"], coordinator_employee_id: "employee-1", orchestration: { mode: "custom", format: "collaboration-markdown-v1", prompt: "1. @{employee-1} → @{employee-2}：整理课程方案。" } } },
  }, responses: { "201": { description: "群配置与固定成员创建成功，尚未触发执行。", examples: { created: { summary: "已创建的自选成员群", value: { data: { ...EXAMPLE_CONVERSATION, id: "group-client-1", kind: "group", entry_employee_id: null, coordinator_employee_id: "employee-1", description: "根据客户需求协同完成课程方案", orchestration: { mode: "auto" } } } } } } } },
  createConversation: { request: { private: { summary: "私聊会话", value: { title: "今日工作摘要", kind: "private", entry_employee_id: "employee-1", permission_mode: "read-only" } }, scheduled: { summary: "一次性调度会话", value: { title: "定时摘要", kind: "private", entry_employee_id: "employee-1", schedule: EXAMPLE_SCHEDULE } } }, responses: { "201": { description: "创建成功的本地会话元数据。", examples: { created: { summary: "创建成功", value: { data: EXAMPLE_CONVERSATION } } } } } },
  getConversation: { responses: { "200": { description: "本地会话元数据。", examples: { conversation: { summary: "会话详情", value: { data: EXAMPLE_CONVERSATION } } } } } },
  updateConversation: { request: { patch: { summary: "部分更新", value: { title: "更新后的标题", labels: ["daily", "updated"], permission_mode: "workspace-write" } }, markRead: { summary: "使用 entries/search 返回的 entry_ref 标记已读（引用仅为形状示例）", value: { last_read_entry_id: "entry_v1_opaque" } } }, responses: { "200": { description: "更新后的本地会话元数据。", examples: { updated: { summary: "更新成功", value: { data: { ...EXAMPLE_CONVERSATION, title: "更新后的标题", labels: ["daily", "updated"], permission_mode: "workspace-write" } } } } } } },
  replaceConversation: { description: "兼容 PUT 的部分更新；未提供字段保持不变。", request: { patch: { summary: "兼容 PUT 的部分更新", value: { title: "更新后的标题" } } }, responses: { "200": { description: "更新后的本地会话元数据；当前 PUT 仍按部分更新处理。", examples: { updated: { summary: "更新成功", value: { data: EXAMPLE_CONVERSATION } } } } } },
  deleteConversation: { responses: { "200": { description: "会话删除结果；关联的本地附件和产物也会被删除。", examples: { deleted: { summary: "删除成功", value: { data: { deleted: true } } } } } } },
  getConversationState: { responses: { "200": { description: "持久化 state 与瞬时 prompting 状态。", examples: { state: { summary: "运行状态", value: { data: { conversation_id: "conversation-1", state: "active", prompting: false } } } } } } },
  setConversationState: { request: { state: { summary: "目标状态", value: { state: "paused" } } }, responses: { "200": { description: "状态更新后的完整会话元数据。", examples: { paused: { summary: "暂停成功", value: { data: { ...EXAMPLE_CONVERSATION, state: "paused" } } } } } } },
  getConversationContext: { responses: { "200": { description: "当前模型和上下文使用情况。", examples: { context: { summary: "上下文状态", value: { data: { conversation_id: "conversation-1", employee_id: "employee-1", model: { provider: "provider-1", id: "model-1", name: "Model One" }, used_tokens: 120, context_window: 128000, percentage: 9, thinking_level: "medium", available_thinking_levels: ["off", "low", "medium", "high"], prompting: false } } } } } } },
  updateConversationContext: { request: { thinking: { summary: "思考档位", value: { thinking_level: "high" } } }, responses: { "200": { description: "更新后的上下文状态。", examples: { updated: { summary: "设置成功", value: { data: { conversation_id: "conversation-1", employee_id: "employee-1", model: null, used_tokens: null, context_window: 0, percentage: null, thinking_level: "high", available_thinking_levels: ["off", "low", "high"], prompting: false } } } } } } },
  setConversationThinkingLevel: { request: { thinking: { summary: "思考档位", value: { thinking_level: "low" } } }, responses: { "200": { description: "更新后的上下文状态；PUT 是 PATCH 的兼容别名。", examples: { updated: { summary: "设置成功", value: { data: { conversation_id: "conversation-1", employee_id: "employee-1", model: null, used_tokens: null, context_window: 0, percentage: null, thinking_level: "low", available_thinking_levels: ["off", "low"], prompting: false } } } } } } },
  promptConversation: { request: { textOnly: { summary: "文本提示", value: { text: "请总结今天的工作" } }, withImages: { summary: "提示、内联图片和附件", value: { text: "请分析附件", images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], attachment_ids: ["file-1"], mentions: ["researcher"] } } }, responses: { "202": { description: "提示已接受或幂等重放；后台执行通过 SSE/entries 获取。", examples: { accepted: { summary: "首次接受", value: { data: { conversation_id: "conversation-1", accepted: true, state: "accepted", idempotency_key: "prompt-1" } } }, completed: { summary: "幂等重放", value: { data: { conversation_id: "conversation-1", accepted: true, state: "completed", idempotency_key: "prompt-1" } } } } } } },
  listConversationEntries: { request: { limit: { summary: "条数", value: 50 }, cursor: { summary: "上一页 next_cursor", value: "page_v1.opaque" }, entry_ref: { summary: "搜索定位", value: "entry_v1_opaque" } }, responses: { "200": { description: "脱敏历史条目；无参数不返回 page，分页参数启用正序续读。", examples: { paged: { summary: "带 limit 的历史分页；引用仅为形状示例，实际值来自响应", value: { data: { conversation_id: "conversation-1", entries: [{ id: "pi-entry-1", entry_ref: "entry_v1_opaque", participant_employee_id: "employee-1", type: "message", parentId: null, timestamp: "2026-09-05T08:00:00.000Z", source_employee_id: "employee-1", source_role: "participant", message: { role: "assistant", content: "以下是今日总结。" } }] }, page: { next_cursor: "page_v1.opaque", has_more: true } } }, entries: { summary: "消息、思考和工具条目", value: { data: { conversation_id: "conversation-1", entries: [{ id: "entry-1", type: "message", timestamp: "2026-09-01T08:02:00.000Z", message: { role: "user", content: "请总结今天的工作" } }, { id: "entry-2", type: "message", timestamp: "2026-09-01T08:02:01.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "整理信息" }, { type: "text", text: "这是摘要" }] } }, { id: "entry-3", type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: false, content: "done" } }] } } } } } } },
  abortConversation: { responses: { "200": { description: "终止结果；没有活动执行时 aborted 为 false。", examples: { aborted: { summary: "终止结果", value: { data: { conversation_id: "conversation-1", aborted: true } } } } } } },
  listAttachments: { responses: { "200": { description: "会话附件元数据列表；当前为一次性结果。", examples: { list: { summary: "附件列表", value: { data: [EXAMPLE_FILE], page: EXAMPLE_PAGE } } } } } },
  listArtifacts: { responses: { "200": { description: "会话产物元数据列表；当前为一次性结果。", examples: { list: { summary: "产物列表", value: { data: [{ ...EXAMPLE_FILE, id: "artifact-1", kind: "artifact", filename: "report.md" }], page: EXAMPLE_PAGE } } } } } },
  uploadAttachment: { request: { file: { summary: "附件上传", value: { filename: "notes.md", mime_type: "text/markdown", data: "bm90ZXM=" } } }, responses: { "201": { description: "已保存的附件元数据；不返回文件字节。", examples: { uploaded: { summary: "上传成功", value: { data: EXAMPLE_FILE } } } } } },
  uploadArtifact: { request: { file: { summary: "产物上传", value: { filename: "report.md", mime_type: "text/markdown", data: "cmVwb3J0" } } }, responses: { "201": { description: "已保存的产物元数据；不返回文件字节。", examples: { uploaded: { summary: "上传成功", value: { data: { ...EXAMPLE_FILE, id: "artifact-1", kind: "artifact", filename: "report.md" } } } } } } },
  downloadAttachment: { responses: { "200": { description: "按文件元数据返回原始二进制；Content-Type 与文件 MIME 一致。", examples: { text: { summary: "文本附件", value: "notes" } } } } },
  downloadArtifact: { responses: { "200": { description: "按文件元数据返回原始二进制；Content-Type 与文件 MIME 一致。", examples: { text: { summary: "文本产物", value: "report" } } } } },
  deleteAttachment: { responses: { "200": { description: "附件删除结果。", examples: { deleted: { summary: "删除成功", value: { data: { deleted: true, id: "file-1" } } } } } } },
  deleteArtifact: { responses: { "200": { description: "产物删除结果。", examples: { deleted: { summary: "删除成功", value: { data: { deleted: true, id: "artifact-1" } } } } } } },
  listAuthorizedExperts: { responses: { "200": { description: "本地已装载的专家授权投影。", examples: { list: { summary: "专家列表", value: { data: [EXAMPLE_EXPERT], page: EXAMPLE_PAGE } } } } } },
  listAuthorizedSolutions: { responses: { "200": { description: "本地已装载的方案授权投影。", examples: { list: { summary: "方案列表", value: { data: [EXAMPLE_SOLUTION], page: EXAMPLE_PAGE } } } } } },
  listFrozenSnapshots: { responses: { "200": { description: "本地冻结执行快照列表。", examples: { list: { summary: "快照列表", value: { data: [EXAMPLE_SNAPSHOT], page: EXAMPLE_PAGE } } } } } },
  grantsReadiness: { responses: { "200": { description: "Agent runtime 和已装载专家的就绪报告。", examples: { ready: { summary: "全部就绪", value: { data: { runtime: "ready", experts: [EXAMPLE_READINESS] } } } } } } },
  expertReadiness: { responses: { "200": { description: "指定专家就绪状态；专家不存在时仍返回 available=false。", examples: { ready: { summary: "专家就绪", value: { data: EXAMPLE_READINESS } }, missing: { summary: "专家未装载", value: { data: { employee_id: "missing", display_name: "missing", handle: "missing", available: false, runtime: "unknown", provider: "unknown", skills: [], capabilities: [], reasons: ["Expert is not authorized locally"] } } } } } } },
  syncGrants: { request: { sync: { summary: "增量同步", value: { tenant_id: "tenant-1", member_id: "member-1", known_versions: { "employee-1": "v1", "solution-1": "v1" } } } }, responses: { "200": { description: "本地授权投影同步结果。", examples: { synced: { summary: "同步成功", value: { data: { ok: true, upserted: 2, revoked: 0 } } } } } } },
  listUsageOutbox: { responses: { "200": { description: "本地脱敏用量摘要上报队列。", examples: { list: { summary: "待上报摘要", value: { data: [{ summary_id: "summary-1", tenant_id: "tenant-1", member_id: "member-1", kind: "usage", status: "pending", attempts: 0, last_error: null, created_at: "2026-09-01T08:00:00.000Z", payload: EXAMPLE_USAGE_SUMMARY }], page: EXAMPLE_PAGE } } } } } },
  flushUsage: { request: { limit: { summary: "批量上限", value: { limit: 50 } } }, responses: { "200": { description: "用量摘要发送结果。", examples: { flushed: { summary: "刷新成功", value: { data: { sent: ["summary-1"], failed: [] } } } } } } },
  listMarketplaceTemplates: { responses: { "200": { description: "当前成员可见的人才市场模板。", examples: { list: { summary: "模板列表", value: { data: [{ template_id: "template-1", display_name: "研究助手", category: "research", model_name: "model-1", description: "研究与报告整理", platform_skill_refs: [{ skill_id: "research", version: "1", content_hash: "sha256:example" }], skills_count: 1, recruit_count: null, is_recruited: false, tags: ["research"], avatar_url: null }], page: EXAMPLE_PAGE } } } } } },
  getMarketplaceTemplate: { responses: { "200": { description: "单个人才市场模板。", examples: { template: { summary: "模板详情", value: { data: { template_id: "template-1", display_name: "研究助手", category: "research", model_name: "model-1", description: "研究与报告整理", platform_skill_refs: [{ skill_id: "research", version: "1", content_hash: "sha256:example" }], skills_count: 1, recruit_count: null, is_recruited: false, tags: ["research"], avatar_url: null } } } } } } },
  orgTree: {
    responses: {
      "200": {
        description: "当前成员可见的递归组织树。",
        examples: {
          tree: {
            summary: "组织树",
            value: { data: { id: "root", name: "企业", type: "department", role_title: null, children: [{ id: "dept-1", name: "研究部", type: "department", role_title: null, parent_id: "root", children: [{ id: "employee-1", name: "研究助手", type: "employee", parent_id: "dept-1", status: "active", role_title: "研究分析师", avatar_url: null, children: [] }] }] } },
          },
        },
      },
    },
  },
  officeScene: {
    responses: {
      "200": {
        description: "本地已装载员工的办公状态和汇总。",
        examples: {
          scene: {
            summary: "办公场景",
            value: { data: { employees: [{ employee_id: "employee-1", display_name: "研究助手", role_title: "研究分析师", department_ids: ["department-research", "department-sales"], status: "working", task: "整理摘要", avatar_url: null, last_activity_at: "2026-09-01T08:02:00.000Z", last_status: "working", last_task: "整理摘要" }], summary: { total: 1, working: 1, ready: 0, offline: 0 } } },
          },
        },
      },
    },
  },
  officeFeed: { responses: { "200": { description: "本地会话调度摘要；不包含实时 Pi 事件。", examples: { feed: { summary: "调度动态", value: { data: { events: [{ type: "conversation_schedule", conversation_id: "conversation-1", title: "定时摘要", schedule: EXAMPLE_SCHEDULE }] } } } } } } },
};

const problemExample = (summary: string, status: number, code: string, detail: string) => ({
  summary,
  value: { type: "about:blank", title: code, status, code, detail, instance: "req-example", request_id: "req-example" },
});
const OPENAPI_COMPONENT_RESPONSES = {
  BadRequest: { description: "请求体不是有效 JSON 或格式不正确。", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" }, examples: { invalidJson: problemExample("请求无效", 400, "invalid_json", "Request body must be a JSON object") } } } },
  Unauthorized: { description: "缺少或无效的认证凭据。", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" }, examples: { unauthenticated: problemExample("未认证", 401, "unauthenticated", "Authentication is required") } } } },
  Forbidden: { description: "已认证身份无权访问目标资源。", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" }, examples: { forbidden: problemExample("无权访问", 403, "forbidden", "Authenticated caller is not authorized") } } } },
  NotFound: { description: "会话、文件或目录资源不存在。", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" }, examples: { notFound: problemExample("资源不存在", 404, "not_found", "Conversation or file not found") } } } },
  Conflict: { description: "请求与当前会话、幂等收据或游标状态冲突。", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" }, examples: { conflict: problemExample("状态冲突", 409, "conflict", "Request conflicts with current state") } } } },
  TooLarge: { description: "请求体、文件或图片超过大小限制。", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" }, examples: { tooLarge: problemExample("内容过大", 413, "request_too_large", "File or request exceeds a limit") } } } },
  ValidationError: { description: "请求参数或请求体校验失败。", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" }, examples: { validation: problemExample("参数校验失败", 422, "validation_error", "Request validation failed") } } } },
  ManagerUnavailable: { description: "Manager 或其受控能力当前不可用。", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" }, examples: { unavailable: problemExample("依赖不可用", 503, "manager_unavailable", "Manager-backed capability is unavailable") } } } },
  BadGateway: { description: "受控上游语音服务返回失败或不可用。", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" }, examples: { upstream: problemExample("上游不可用", 502, "speech_upstream_unavailable", "Speech transcription service is unavailable") } } } },
  InternalError: { description: "Agent 未预期的内部错误；详细信息只写入受控日志。", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" }, examples: { internal: problemExample("内部错误", 500, "internal_error", "Internal server error") } } } },
  Gone: { description: "该 Agent 接口已移除，请使用文档中指定的替代能力。", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" }, examples: { gone: problemExample("接口已移除", 410, "gone", "Agent knowledge base endpoints were removed; use the Pi knowledge tools") } } } },
  TooManyRequests: { description: "请求频率超过限制。", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" }, examples: { rateLimited: problemExample("请求过多", 429, "rate_limited", "Too many requests") } } } },
} as const;

const SWAGGER_SSE_SCHEMA_NAVIGATION_JS = String.raw`(() => {
  const href = "#/components/schemas/PiSseEventData";
  const title = "PiSseEventData";

  function findSchema() {
    return Array.from(document.querySelectorAll("article.json-schema-2020-12"))
      .find((article) => article.querySelector(".json-schema-2020-12__title")?.textContent?.trim() === title);
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    const link = target instanceof Element ? target.closest("a[href='" + href + "']") : null;
    if (!link) return;
    const schemaSection = document.querySelector(".models");
    const schemaToggle = schemaSection?.querySelector("button.models-control");
    if (schemaToggle?.getAttribute("aria-expanded") === "false") schemaToggle.click();
    const expandSchema = () => {
      const schema = findSchema();
      if (!schema) return;
      const accordion = schema.querySelector("button.json-schema-2020-12-accordion");
      const collapsed = accordion?.getAttribute("aria-expanded") === "false"
        || accordion?.querySelector(".json-schema-2020-12-accordion__icon--collapsed") !== null;
      if (accordion && collapsed) accordion.click();
      schema.scrollIntoView({ block: "center", behavior: "auto" });
    };
    event.preventDefault();
    event.stopImmediatePropagation();
    requestAnimationFrame(() => requestAnimationFrame(expandSchema));
  }, true);
})();`;

function routeSchema(operationId: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { operationId, ...fields };
}

function normalizeAllowedOrigins(origins: readonly string[]): ReadonlySet<string> {
  const values = new Set(origins.map((origin) => origin.trim()).filter(Boolean));
  if (values.has("*")) throw new Error("AITEAM_AGENT_ALLOWED_ORIGINS does not support wildcard origins");
  return values;
}

export interface AgentHttpServerOptions {
  host: SessionHost;
  store: AgentSqliteStore;
  authenticate: AuthenticateRequest;
  runtimeReady?: () => boolean | Promise<boolean>;
  localReady?: () => boolean | Promise<boolean>;
  managerClient?: ManagerClient;
  logger?: Pick<Console, "error">;
  spaRoot?: string;
  /** Exact browser origins allowed to call this local sidecar. Empty means no CORS. */
  allowedOrigins?: readonly string[];
  usageFlush?: UsageFlushService;
  skillCache?: SkillCache;
  /** Injected for deterministic upstream transcription tests. */
  fetch?: typeof fetch;
}

export class HttpProblem extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly errors?: unknown) {
    super(message);
    this.name = "HttpProblem";
  }
}

export class AgentHttpServer {
  readonly server: Server;
  private readonly app: FastifyInstance;
  private requests = 0;
  private errors = 0;
  private readonly promptWorkers = new Set<Promise<void>>();
  private readonly fetchImpl: typeof fetch;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly conversationReads: ConversationReadService;
  private readonly groupCreation: GroupCreationService;
  private readonly workRecords: WorkRecordReadService;
  private readonly usageStatistics: UsageStatisticsService;

  constructor(private readonly options: AgentHttpServerOptions) {
    this.conversationReads = new ConversationReadService(options.store, options.host);
    this.groupCreation = new GroupCreationService(options.store, options.host);
    this.workRecords = new WorkRecordReadService(options.store, options.host);
    this.usageStatistics = new UsageStatisticsService(options.store);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins ?? []);
    this.app = Fastify({
      bodyLimit: MAX_UPLOAD_JSON_BYTES,
      requestIdHeader: "x-request-id",
      genReqId: () => randomUUID(),
      logger: false,
    });
    // Fastify rejects an empty JSON body before the handler. Several command-style
    // Agent endpoints intentionally accept an empty JSON request, so preserve the
    // previous HTTP contract while still rejecting malformed JSON.
    this.app.removeContentTypeParser("application/json");
    this.app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
      const text = typeof body === "string" ? body : body.toString("utf8");
      if (text.trim() === "") return done(null, {});
      try { return done(null, JSON.parse(text)); }
      catch { return done(new HttpProblem(400, "invalid_json", "Request body must be valid JSON")); }
    });
    // Business handlers retain the existing trust-boundary validation. Fastify
    // schemas are the single OpenAPI source, without changing their legacy
    // error/status semantics through a second validator/serializer.
    this.app.setValidatorCompiler(() => () => true);
    this.app.setSerializerCompiler(() => (data) => JSON.stringify(data));
    this.server = this.app.server;
    this.app.addHook("onRequest", async (request, reply) => {
      this.requests += 1;
      reply.raw.setHeader("X-Request-ID", request.id);
      const origin = request.headers.origin;
      if (origin && this.allowedOrigins.has(origin)) {
        // Business handlers intentionally write through reply.raw/hijack; put
        // CORS headers on the raw response so they survive that boundary.
        reply.raw.setHeader("Access-Control-Allow-Origin", origin);
        reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
        reply.raw.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, Last-Event-ID");
        reply.raw.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        reply.raw.setHeader("Access-Control-Expose-Headers", "X-Request-ID");
        reply.raw.setHeader("Access-Control-Max-Age", "600");
        reply.raw.setHeader("Vary", "Origin");
        if (request.method === "OPTIONS") return reply.code(204).send();
      } else if (request.method === "OPTIONS" && origin) {
        return reply.code(403).send();
      }
    });
    this.app.setErrorHandler((error, request, reply) => {
      this.errors += 1;
      if (!(error instanceof EventCursorStaleError)) this.options.logger?.error(error);
      reply.hijack();
      this.writeError(reply.raw, this.fastifyError(error), String(request.id));
    });
    this.app.setNotFoundHandler((request, reply) => {
      reply.hijack();
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (request.method === "GET" && this.serveSpa(pathname, reply.raw)) return;
      this.errors += 1;
      this.writeError(reply.raw, new HttpProblem(404, "not_found", "Route not found"), String(request.id));
    });
    void this.app.register(swagger, {
      openapi: {
        openapi: "3.1.0",
        info: { title: "AI Team Agent Service", version: "0.1.0", description: "AI Team v1 用户本地 Agent API；会话与执行内容仅保存在本机。" },
        components: {
          securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "本地登录返回的短期 Bearer access token。" } },
          headers: {
            RequestId: { description: "请求关联 ID；也会出现在 problem+json 的 request_id。", schema: { type: "string" } },
          },
          responses: OPENAPI_COMPONENT_RESPONSES,
        },
      },
      refResolver: { buildLocalReference: (json: any, _baseUri: any, _fragment: string, index: number) => json.$id ?? `def-${index}` },
      transformObject: (documentObject: any) => {
        const openapiObject = documentObject.openapiObject ?? documentObject.swaggerObject;
        const responseNames = new Set(["BadRequest", "Unauthorized", "Forbidden", "NotFound", "Conflict", "TooLarge", "ValidationError", "ManagerUnavailable", "BadGateway", "InternalError", "Gone", "TooManyRequests"]);
        const parameterDescriptions: Record<string, string> = {
          conversation_id: "本地会话 ID。", attachment_id: "本地附件 ID。", artifact_id: "授权附件 ID。", employee_id: "授权员工/专家 ID。", template_id: "专家模板 ID。",
          knowledge_base_id: "旧知识库 ID。", resource_id: "旧资源 ID。", kind: "旧资源类型。", after: "从指定事件之后继续读取；优先于 Last-Event-ID。", cursor: "从上一条会话之后继续读取。", limit: "返回条数上限；缺省为 50，最大 100。", "Idempotency-Key": "写操作幂等键；相同键只能对应同一请求体。", "Last-Event-ID": "SSE 断线重连游标；未提供 after 时使用。",
        };
        const humanize = (value: string) => value.replace(/_/gu, " ").replace(/([a-z])([A-Z])/gu, "$1 $2");
        const enrichNode = (node: any, field?: string): void => {
          if (!node || typeof node !== "object") return;
          if (node.type === "object" && node.additionalProperties === true) node["x-dynamic-json"] = true;
          if (field && !node.description && !node.$ref) {
            node.description = parameterDescriptions[field]
              ?? (node.type === "null" ? "允许为 null。" : node.type === "array" ? `${humanize(field)} 列表元素。` : node.type === "object" ? `${humanize(field)} 对象。` : `${humanize(field)} 字段值。`);
          }
          if (node.properties && typeof node.properties === "object") for (const [name, child] of Object.entries(node.properties)) enrichNode(child, name);
          if (node.items) enrichNode(node.items, field);
          for (const key of ["anyOf", "oneOf", "allOf"]) for (const child of node[key] ?? []) enrichNode(child, field);
        };
        for (const [path, pathItem] of Object.entries(openapiObject.paths ?? {})) {
          for (const [method, operation] of Object.entries(pathItem as Record<string, any>)) {
            if (!operation || typeof operation !== "object" || !operation.responses || !["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method)) continue;
            const operationId = String(operation.operationId ?? `${method}_${path}`);
            const summary = String(operation.summary ?? humanize(operationId));
            operation.summary = summary;
            if (!operation.description || operation.description === "请查看接口名称了解用途") operation.description = `${summary}。成功响应遵循本地 Agent envelope；失败响应使用 application/problem+json。`;
            operation.tags ??= [path.startsWith("/api/auth/") ? "auth" : "agent"];
            if (!operation.security) operation.security = path.startsWith("/api/auth/") || path.endsWith("/login") || path.endsWith("/reset-password") ? [] : [{ bearerAuth: [] }];
            const operationDocs = OPENAPI_OPERATION_DOCS[operationId];
            if (operationDocs?.description) operation.description = operationDocs.description;
            if (operationDocs?.request) {
              if (operation.requestBody?.content) {
                for (const content of Object.values(operation.requestBody.content) as any[]) content.examples ??= operationDocs.request;
              } else {
                for (const [name, example] of Object.entries(operationDocs.request)) {
                  const parameter = (operation.parameters ?? []).find((item: any) => item.name === name);
                  if (parameter) parameter.example ??= example.value;
                }
              }
            }
            for (const parameter of operation.parameters ?? []) {
              if (!parameter.description) parameter.description = parameterDescriptions[parameter.name] ?? `请求${parameter.in}参数：${humanize(parameter.name)}。`;
              if (parameter.example === undefined && OPENAPI_PARAMETER_EXAMPLES[parameter.name] !== undefined) parameter.example = OPENAPI_PARAMETER_EXAMPLES[parameter.name];
              enrichNode(parameter.schema, parameter.name);
            }
            const authenticated = Array.isArray(operation.security) && operation.security.length > 0;
            if (operation.requestBody) operation.responses["400"] ??= { $ref: "#/components/responses/BadRequest" };
            if (path.startsWith("/api/")) operation.responses["500"] ??= { $ref: "#/components/responses/InternalError" };
            operation.responses["422"] ??= { $ref: "#/components/responses/ValidationError" };
            const publicAuth = path.startsWith("/api/auth/") || path.endsWith("/login") || path.endsWith("/reset-password");
            const managerBacked = publicAuth || MANAGER_BACKED_OPERATION_IDS.has(operationId);
            if (authenticated || publicAuth) operation.responses["401"] ??= { $ref: "#/components/responses/Unauthorized" };
            if (authenticated || publicAuth) operation.responses["403"] ??= { $ref: "#/components/responses/Forbidden" };
            if (managerBacked) operation.responses["503"] ??= { $ref: "#/components/responses/ManagerUnavailable" };
            else delete operation.responses["503"];
            if (path === "/api/auth/resolve-tenant-by-account") {
              operation.responses["404"] ??= { $ref: "#/components/responses/NotFound" };
              operation.responses["409"] ??= { $ref: "#/components/responses/Conflict" };
            }
            if (["createConversation", "listConversationEntries", "subscribeConversationEvents", "getConversationState", "setConversationState", "getConversationContext", "updateConversationContext", "setConversationThinkingLevel", "promptConversation"].includes(operationId)) operation.responses["404"] ??= { $ref: "#/components/responses/NotFound" };
            if (operationId === "subscribeConversationEvents") operation.responses["409"] ??= { $ref: "#/components/responses/Conflict" };
            if (operationId === "transcribeAudio") operation.responses["502"] ??= { $ref: "#/components/responses/BadGateway" };
            if (["post", "put", "patch", "delete"].includes(method)) operation.responses["409"] ??= { $ref: "#/components/responses/Conflict" };
            for (const [status, response] of Object.entries(operation.responses as Record<string, any>)) {
              const responseDocs = operationDocs?.responses?.[status];
              if (responseDocs?.description && response && typeof response === "object" && !response.$ref) response.description = responseDocs.description;
              if (responseDocs?.examples && response?.content) {
                for (const content of Object.values(response.content) as any[]) content.examples ??= responseDocs.examples;
              }
              if (response && typeof response === "object" && !response.$ref) {
                response.headers ??= {};
                response.headers["X-Request-ID"] ??= { $ref: "#/components/headers/RequestId" };
                if (operationId === "subscribeConversationEvents" && status === "200") {
                  response.headers["Cache-Control"] = { description: "禁止缓存和代理转换。", schema: { type: "string", example: "no-cache, no-transform" } };
                  response.headers.Connection = { description: "保持 SSE 长连接。", schema: { type: "string", example: "keep-alive" } };
                  response.headers["X-Accel-Buffering"] = { description: "关闭 Nginx 缓冲。", schema: { type: "string", example: "no" } };
                }
                if (["downloadAttachment", "downloadArtifact"].includes(operationId) && status === "200") {
                  response.headers["Content-Disposition"] = { description: "服务端生成的安全下载文件名。", schema: { type: "string", example: "attachment; filename=notes.md" } };
                  response.headers["Content-Length"] = { description: "文件字节数。", schema: { type: "integer", minimum: 0 } };
                }
                if (operationId === "transcribeAudio" && status === "200") response.headers["Cache-Control"] = { description: "语音结果不缓存。", schema: { type: "string", example: "no-store" } };
              }
              if (response && responseNames.has(response.description)) {
                operation.responses[status] = { $ref: `#/components/responses/${response.description}` };
                continue;
              }
              for (const content of Object.values(response?.content ?? {}) as any[]) enrichNode(content.schema);
            }
          }
        }
        for (const response of Object.values(openapiObject.components?.responses ?? {}) as any[]) {
          if (response && typeof response === "object") {
            response.headers ??= {};
            response.headers["X-Request-ID"] ??= { $ref: "#/components/headers/RequestId" };
          }
        }
        for (const [name, model] of Object.entries(openapiObject.components?.schemas ?? {})) {
          const schema = model as any;
          schema.description ??= `${humanize(name)} 数据结构。`;
          enrichNode(schema);
        }
        return openapiObject;
      },
    });
    this.app.after(() => {
      for (const schema of OPENAPI_SCHEMAS) this.app.addSchema(schema);
      this.registerRoutes();
      // Do not emit `upgrade-insecure-requests`: taiyi/dev serves HTTP directly;
      // TLS termination can add that policy at the edge without breaking local docs.
      this.app.register(swaggerUi, {
        routePrefix: "/docs",
        uiConfig: { url: "/openapi.json", docExpansion: "list" },
        theme: { js: [{ filename: "aiteam-sse-schema-navigation.js", content: SWAGGER_SSE_SCHEMA_NAVIGATION_JS }] },
      });
    });
  }

  async listen(port: number, host = "127.0.0.1"): Promise<void> {
    await this.app.listen({ port, host });
  }

  async close(): Promise<void> {
    await this.options.host.abortAll();
    await Promise.allSettled([...this.promptWorkers]);
    await this.app.close();
  }

  private registerRoutes(): void {
    const jsonResponse = (schema: unknown, description = "Successful response") => ({ description, content: { "application/json": { schema } } });
    const problemResponse = (name: "BadRequest" | "Unauthorized" | "Forbidden" | "NotFound" | "Conflict" | "TooLarge" | "ValidationError" | "ManagerUnavailable" | "BadGateway" | "InternalError" | "Gone" | "TooManyRequests") => ({ description: name, content: { "application/problem+json": { schema: Type.Ref("Problem") } } });
    this.registerRoute("GET", "/healthz", (_request, response) => this.writeJson(response, 200, { data: { status: "ok" } }), routeSchema("healthz", { summary: "Agent 存活检查", description: "检查 Agent 进程是否存活。", response: { 200: jsonResponse(Type.Object({ data: Type.Object({ status: Type.String({ description: "服务状态。" }) }, { additionalProperties: false }) }, { additionalProperties: false })) } }), false);
    this.registerRoute("GET", "/metrics", (_request, response) => this.writeMetrics(response), routeSchema("metrics", { summary: "导出 Agent 指标", description: "返回 Prometheus 文本格式的本地 Agent 指标。", response: { 200: { description: "Prometheus metrics", content: { "text/plain": { schema: Type.String({ description: "Prometheus 指标文本。" }) } } } } }), false);
    this.registerRoute("GET", "/readyz", async (_request, response) => {
      let ready = false;
      try {
        this.options.store.db.prepare("SELECT 1").get();
        ready = (await this.options.localReady?.()) ?? true;
      } catch { ready = false; }
      this.writeJson(response, ready ? 200 : 503, { data: { ready } });
    }, routeSchema("readyz", { summary: "Agent 就绪检查", description: "检查本地数据库、工作目录和 sandbox 是否可用。", response: { 200: jsonResponse(Type.Object({ data: Type.Object({ ready: Type.Boolean({ description: "本地 Agent 是否就绪。" }) }, { additionalProperties: false }) })), 503: jsonResponse(Type.Object({ data: Type.Object({ ready: Type.Boolean({ description: "本地 Agent 是否就绪。" }) }, { additionalProperties: false }) })) } }), false);
    this.registerRoute(
      "GET",
      "/openapi.json",
      (_request, response) => this.writeJson(response, 200, this.app.swagger()),
      routeSchema("openapi", {
        summary: "获取 Agent OpenAPI",
        description: "返回当前用户端 Agent 的 OpenAPI 3.1 文档。",
        response: {
          200: {
            description: "OpenAPI 3.1 文档对象。",
            content: {
              "application/json": {
                schema: Type.Object({
                  openapi: Type.String({ description: "OpenAPI 版本。" }),
                  info: Type.Object({ title: Type.String({ description: "文档标题。" }), version: Type.String({ description: "文档版本。" }) }, { additionalProperties: true, description: "文档元数据。" }),
                  paths: Type.Record(Type.String(), Type.Any(), { description: "本端 HTTP 路由定义。" }),
                }, { additionalProperties: true, description: "Agent OpenAPI 3.1 文档对象。", "x-dynamic-json": true }),
              },
            },
          },
        },
      }),
      false,
    );
    this.registerRoute("GET", "/redoc", (_request, response) => this.writeHtml(response, redocHtml("/openapi.json")), routeSchema("redoc", { summary: "查看 Agent ReDoc", description: "使用 ReDoc 渲染当前 Agent OpenAPI 文档。", response: { 200: { description: "ReDoc HTML 页面。", content: { "text/html": { schema: Type.String({ description: "ReDoc HTML 文本。" }) } } } } }), false);
    this.registerRoute("GET", "/redoc/redoc.standalone.js", (_request, response) => this.writeText(response, 200, REDOC_BUNDLE, "text/javascript; charset=utf-8"), routeSchema("redocBundle", { summary: "获取 ReDoc 静态资源", description: "返回 ReDoc JavaScript 资源。", response: { 200: { description: "ReDoc JavaScript 资源。", content: { "text/javascript": { schema: Type.String({ description: "JavaScript 文本。" }) } } } } }), false);

    this.registerRoute("POST", "/api/auth/resolve-tenant-by-account", (request, response) => this.resolveTenantByAccount(request, response), routeSchema("resolveTenantByAccount", { summary: "解析员工账号所属企业", description: "在登录前根据员工账号解析唯一企业租户。", body: Type.Ref("ResolveTenantRequest"), response: { 200: jsonResponse(Type.Ref("TenantResolutionEnvelope"), "租户解析成功；仅返回 tenant_id。"), 400: problemResponse("BadRequest"), 404: problemResponse("NotFound"), 409: problemResponse("Conflict") } }), false);
    this.registerRoute("POST", "/api/agent/login", (request, response) => this.login(request, response), routeSchema("login", { summary: "Agent 登录", description: "使用 Manager 返回的企业租户、账号和密码建立本地会话。", body: Type.Ref("AgentLoginRequest"), response: { 200: jsonResponse(Type.Ref("AuthResultEnvelope")) } }), false);
    this.registerRoute("POST", "/api/agent/reset-password", (request, response) => this.resetPassword(request, response), routeSchema("resetPassword", { summary: "重置负责人密码", description: "使用当前凭据向 Manager 请求重置密码。", body: Type.Ref("AgentResetPasswordRequest"), response: { 200: jsonResponse(Type.Ref("AuthResultEnvelope")) } }), false);
    this.registerRoute("POST", "/api/agent/audio/transcriptions", (request, response, caller) => this.transcribeAudio(request, response, caller!), routeSchema("transcribeAudio", { summary: "语音转文字", description: "使用当前成员所属企业已开放的 ASR 模型，把本地录音转换为文本；不绑定 employee。", body: Type.Ref("AudioTranscriptionRequest"), response: { 200: jsonResponse(Type.Ref("AudioTranscriptionEnvelope")), 400: problemResponse("BadRequest"), 401: problemResponse("Unauthorized"), 413: problemResponse("TooLarge"), 422: problemResponse("ValidationError"), 502: problemResponse("BadGateway"), 503: problemResponse("ManagerUnavailable") } }));

    this.registerRoute("GET", "/api/agent/ping", (_request, response) => this.writeJson(response, 200, { data: { pong: true } }), routeSchema("ping", { summary: "Agent 存活探针", description: "返回当前本地 Agent 的固定存活结果。", response: { 200: jsonResponse(Type.Ref("PingEnvelope")) } }), false);
    this.registerRoute("GET", "/api/agent/whoami", (_request, response, caller) => this.writeJson(response, 200, { data: caller!.claims ?? { user_id: caller!.userId ?? caller!.callerId, tenant_id: caller!.tenantId!, roles: caller!.roles ?? [] } }), routeSchema("whoami", { summary: "查看当前身份", description: "返回本地验签后的当前成员身份声明。", response: { 200: jsonResponse(Type.Ref("ClaimsEnvelope")) } }));
    this.registerRoute("GET", "/api/agent/conversations", (request, response, caller) => this.listConversations(response, new URL(request.url ?? "/", "http://localhost").searchParams, caller!), routeSchema("listConversations", { summary: "列出本地会话", description: "按当前成员列出本地会话，支持游标和条数限制。", querystring: ConversationQuery, response: { 200: jsonResponse(Type.Ref("ConversationListEnvelope")) } }));
    this.registerRoute("POST", "/api/agent/conversations/custom-group", (request, response, caller) => this.createCustomGroup(request, response, caller!), routeSchema("createCustomGroup", {
      summary: "自定义创建群聊", description: "指定当前用户授权成员和协调人，保存群简介及自动或自定义编排。创建不触发模型执行；固定客户端 ID 冲突返回 409，可读取原会话恢复。",
      body: Type.Ref("CustomGroupCreateRequest"), response: { 201: jsonResponse(Type.Ref("ConversationEnvelope")), 403: problemResponse("Forbidden"), 404: problemResponse("NotFound"), 409: problemResponse("Conflict"), 422: problemResponse("ValidationError") },
    }));
    this.registerRoute("POST", "/api/agent/conversations", (request, response, caller) => this.createConversation(request, response, caller!), routeSchema("createConversation", { summary: "创建本地会话", description: "创建私聊、群聊或任务会话；会话内容仅保存在本机。", body: Type.Ref("ConversationCreateRequest"), response: { 201: jsonResponse(Type.Ref("ConversationEnvelope")), 403: problemResponse("Forbidden"), 404: problemResponse("NotFound") } }));
    this.registerRoute("GET", "/api/agent/conversations/:conversation_id", (_request, response, caller, fastifyRequest) => this.getConversation(response, (fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!), routeSchema("getConversation", { summary: "获取本地会话", description: "返回当前成员拥有的本地会话元数据。", params: ConversationParams, response: { 200: jsonResponse(Type.Ref("ConversationEnvelope")), 404: problemResponse("NotFound") } }));
    const conversationUpdateSchema = routeSchema("updateConversation", { summary: "更新本地会话", description: "更新会话标题、标签、权限、调度或已读位置。", params: ConversationParams, body: Type.Ref("ConversationUpdateRequest"), response: { 200: jsonResponse(Type.Ref("ConversationEnvelope")), 404: problemResponse("NotFound") } });
    this.registerRoute("PATCH", "/api/agent/conversations/:conversation_id", (request, response, caller, fastifyRequest) => this.updateConversation(request, response, (fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!), conversationUpdateSchema);
    this.registerRoute("PUT", "/api/agent/conversations/:conversation_id", (request, response, caller, fastifyRequest) => this.updateConversation(request, response, (fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!), { ...conversationUpdateSchema, operationId: "replaceConversation" });
    this.registerRoute("DELETE", "/api/agent/conversations/:conversation_id", (_request, response, caller, fastifyRequest) => this.deleteConversation(response, (fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!), routeSchema("deleteConversation", { summary: "删除本地会话", description: "删除当前成员拥有的会话及其本地执行状态。", params: ConversationParams, response: { 200: jsonResponse(Type.Ref("ConversationDeleteEnvelope")), 404: problemResponse("NotFound") } }));
    this.registerRoute("GET", "/api/agent/conversations/:conversation_id/state", (_request, response, caller, fastifyRequest) => this.getConversationState(response, (fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!), routeSchema("getConversationState", { summary: "获取会话运行状态", description: "返回会话持久化状态以及当前是否正在执行提示。", params: ConversationParams, response: { 200: jsonResponse(Type.Ref("ConversationStateEnvelope")), 404: problemResponse("NotFound") } }));
    this.registerRoute("PUT", "/api/agent/conversations/:conversation_id/state", (request, response, caller, fastifyRequest) => this.updateConversationState(request, response, (fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!), routeSchema("setConversationState", { summary: "更新会话状态", description: "更新当前成员会话的持久化状态。", params: ConversationParams, body: Type.Ref("ConversationStateUpdateRequest"), response: { 200: jsonResponse(Type.Ref("ConversationEnvelope")), 404: problemResponse("NotFound") } }));
    this.registerRoute("GET", "/api/agent/conversations/:conversation_id/context", (_request, response, caller, fastifyRequest) => this.getConversationContext(response, (fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!), routeSchema("getConversationContext", { summary: "获取会话上下文状态", description: "返回当前本地 Pi 会话的模型、上下文 token 使用量、窗口、百分比和思考档位；不返回会话正文或凭据。", params: ConversationParams, response: { 200: jsonResponse(Type.Ref("ConversationContextEnvelope")), 404: problemResponse("NotFound") } }));
    this.registerRoute("PATCH", "/api/agent/conversations/:conversation_id/context", (request, response, caller, fastifyRequest) => this.updateConversationContext(request, response, (fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!), routeSchema("updateConversationContext", { summary: "更新会话思考档位", description: "更新当前成员本地会话的思考档位，并应用到后续 Pi 提示。", params: ConversationParams, body: Type.Ref("ConversationThinkingLevelRequest"), response: { 200: jsonResponse(Type.Ref("ConversationContextEnvelope")), 404: problemResponse("NotFound"), 409: problemResponse("Conflict"), 422: problemResponse("ValidationError") } }));
    this.registerRoute("PUT", "/api/agent/conversations/:conversation_id/thinking-level", (request, response, caller, fastifyRequest) => this.updateConversationContext(request, response, (fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!), routeSchema("setConversationThinkingLevel", { summary: "设置会话思考档位", description: "设置当前成员本地会话的思考档位，并应用到后续 Pi 提示。", params: ConversationParams, body: Type.Ref("ConversationThinkingLevelRequest"), response: { 200: jsonResponse(Type.Ref("ConversationContextEnvelope")), 404: problemResponse("NotFound"), 409: problemResponse("Conflict"), 422: problemResponse("ValidationError") } }));

    const promptHeaders = Type.Object({ "Idempotency-Key": Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: true });
    this.registerRoute("POST", "/api/agent/conversations/:conversation_id/prompt", (request, response, caller, fastifyRequest) => this.prompt(request, response, String((fastifyRequest?.params as { conversation_id: string }).conversation_id), caller!), routeSchema("promptConversation", { summary: "提交会话提示", description: "向本地会话提交文本、图片和群聊提及；使用 Idempotency-Key 保证重试安全。", params: ConversationParams, headers: promptHeaders, body: Type.Ref("PromptRequest"), response: { 202: jsonResponse(Type.Ref("PromptAcceptedEnvelope")), 403: problemResponse("Forbidden"), 404: problemResponse("NotFound"), 409: problemResponse("Conflict"), 413: problemResponse("TooLarge"), 422: problemResponse("ValidationError") } }));
    this.registerRoute("GET", "/api/agent/conversations/:conversation_id/events", (request, response, caller, fastifyRequest) => {
      const conversationId = String((fastifyRequest?.params as { conversation_id: string }).conversation_id);
      this.requireOwnedConversation(conversationId, caller!);
      return this.events(request, response, conversationId, new URL(request.url ?? "/", "http://localhost").searchParams.get("after"));
    }, routeSchema("subscribeConversationEvents", {
      summary: "订阅会话事件流",
      description: PI_EVENT_STREAM_DESCRIPTION,
      params: ConversationParams,
      querystring: Type.Object({ after: Type.Optional(Type.String({ minLength: 1, description: "客户端上次收到的事件 ID；历史正文请通过 /entries 获取，且优先于 Last-Event-ID。" })) }, { additionalProperties: false, description: "SSE 断点续读参数。" }),
      headers: Type.Object({ "Last-Event-ID": Type.Optional(Type.String({ minLength: 1, description: "SSE 断线重连游标；未提供 after 查询参数时使用。" })) }, { additionalProperties: true, description: "SSE 断线重连游标。" }),
      response: {
        200: {
          description: "Pi SSE 事件流。每条事件使用 `event: pi`，并在 `data` 行携带一个 JSON 对象。",
          headers: {
            "Cache-Control": { description: "固定为 no-cache, no-transform。", schema: { type: "string", example: "no-cache, no-transform" } },
            Connection: { description: "保持 SSE 长连接。", schema: { type: "string", example: "keep-alive" } },
            "X-Accel-Buffering": { description: "固定为 no，避免代理缓冲。", schema: { type: "string", example: "no" } },
          },
          content: {
            "text/event-stream": {
              schema: Type.String({ description: "SSE 事件流文本；每个 data 行的 JSON 结构见 <a href='#/components/schemas/PiSseEventData' target='_self'>PiSseEventData</a>。" }),
              examples: PI_EVENT_STREAM_EXAMPLES,
              "x-event-data-schema": { $ref: "#/components/schemas/PiSseEventData" },
            },
          },
        },
      },
    }));
    this.registerRoute("GET", "/api/agent/conversations/:conversation_id/entries", async (request, response, caller, fastifyRequest) => {
      const conversationId = String((fastifyRequest?.params as { conversation_id: string }).conversation_id);
      this.writeJson(response, 200, await this.conversationReads.entries(conversationId, caller!, new URL(request.url ?? "/", "http://localhost").searchParams));
    }, routeSchema("listConversationEntries", { summary: "列出会话条目", description: "只读 Pi 历史，按 timestamp、conversation ID、participant ID、Session append ordinal、Pi ID 正序。无参数保持旧 data.entries 响应；limit/cursor/entry_ref 启用分页。entry_ref 唯一定位，raw id/parentId 不变；SSE ID 不是历史游标，transient delta 不持久回放。", params: ConversationParams, querystring: HistoryQuery, response: { 200: jsonResponse(Type.Ref("ConversationEntriesEnvelope")), 404: problemResponse("NotFound") } }));
    this.registerRoute("GET", "/api/agent/conversations/:conversation_id/participants", (_request, response, caller, fastifyRequest) => {
      this.writeJson(response, 200, this.conversationReads.participants((fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!));
    }, routeSchema("listConversationParticipants", { summary: "读取真实会话成员", description: "仅返回已存在的固定 participant Session 索引成员，不回退到授权全集；撤权成员仍可见但不可执行，不返回本机路径。", params: ConversationParams, response: { 200: jsonResponse(Type.Ref("ConversationParticipantsEnvelope")), 404: problemResponse("NotFound") } }));
    this.registerRoute("GET", "/api/agent/messages/search", (request, response, caller) => {
      this.writeJson(response, 200, this.conversationReads.search(caller!, new URL(request.url ?? "/", "http://localhost").searchParams));
    }, routeSchema("searchMessages", { summary: "搜索本机消息全文", description: "扫描当前 owner 的全部会话 JSONL，匹配完整脱敏可见文本（不受 HTTP 4,000 字/32 块展示截断影响），只返回安全 snippet 与 entry_ref。按 timestamp、conversation ID、participant ID、Session append ordinal、Pi ID 全 tuple 倒序，cursor 绑定 q/会话/发送员工筛选。只读不创建 Session，不上传内容，不搜索 thinking/tool/internal。", querystring: MessageSearchQuery, response: { 200: jsonResponse(Type.Ref("MessageSearchEnvelope")), 404: problemResponse("NotFound") } }));
    this.registerRoute("POST", "/api/agent/conversations/:conversation_id/abort", async (_request, response, caller, fastifyRequest) => {
      const conversationId = String((fastifyRequest?.params as { conversation_id: string }).conversation_id);
      this.requireOwnedConversation(conversationId, caller!);
      const aborted = await this.options.host.abort(conversationId);
      this.writeJson(response, 200, { data: { conversation_id: conversationId, aborted } });
    }, routeSchema("abortConversation", { summary: "终止会话执行", description: "请求终止当前会话中正在运行的 Pi 提示。", params: ConversationParams, response: { 200: jsonResponse(Type.Ref("AbortEnvelope")), 404: problemResponse("NotFound") } }));

    const fileCollection = (kind: LocalFileKind, operationId: string, params: unknown) => {
      const route = (fastifyRequest?: FastifyRequest) => ({ conversationId: String((fastifyRequest?.params as { conversation_id?: string })?.conversation_id ?? ""), kind });
      this.registerRoute("GET", `/api/agent/conversations/:conversation_id/${kind === "artifact" ? "artifacts" : "attachments"}`, (_request, response, caller, fastifyRequest) => this.listLocalFiles(response, route(fastifyRequest), caller!), routeSchema(operationId, { summary: kind === "artifact" ? "列出会话产物" : "列出会话附件", description: `列出当前成员会话中的本地${kind === "artifact" ? "产物" : "附件"}元数据。`, params, response: { 200: jsonResponse(Type.Ref("LocalFileListEnvelope")), 401: problemResponse("Unauthorized"), 404: problemResponse("NotFound") } }));
      this.registerRoute("POST", `/api/agent/conversations/:conversation_id/${kind === "artifact" ? "artifacts" : "attachments"}`, (request, response, caller, fastifyRequest) => this.uploadLocalFile(request, response, route(fastifyRequest), caller!), routeSchema(kind === "artifact" ? "uploadArtifact" : "uploadAttachment", { summary: kind === "artifact" ? "上传会话产物" : "上传会话附件", description: `向当前成员会话上传本地${kind === "artifact" ? "产物" : "附件"}。`, params, body: Type.Ref("LocalFileUpload"), response: { 201: jsonResponse(Type.Ref("LocalFileEnvelope")), 401: problemResponse("Unauthorized"), 404: problemResponse("NotFound"), 413: problemResponse("TooLarge"), 422: problemResponse("ValidationError") } }));
    };
    fileCollection("attachment", "listAttachments", ConversationParams);
    fileCollection("artifact", "listArtifacts", ConversationParams);
    const fileItem = (kind: LocalFileKind, idName: "attachment_id" | "artifact_id", operationPrefix: string, params: unknown) => {
      const route = (request: IncomingMessage, fastifyRequest?: FastifyRequest) => { const values = fastifyRequest?.params as Record<string, string>; return { conversationId: values.conversation_id, kind, fileId: values[idName] }; };
      const path = `/api/agent/conversations/:conversation_id/${kind === "artifact" ? "artifacts" : "attachments"}/:${idName}`;
      this.registerRoute("GET", path, (request, response, caller, fastifyRequest) => this.downloadLocalFile(response, route(request, fastifyRequest), caller!), routeSchema(`download${operationPrefix}`, { summary: `下载会话${kind === "artifact" ? "产物" : "附件"}`, description: `下载当前成员会话中的${kind === "artifact" ? "产物" : "附件"}二进制内容。`, params, response: { 200: { description: "Local file bytes", content: LOCAL_FILE_DOWNLOAD_CONTENT }, 401: problemResponse("Unauthorized"), 404: problemResponse("NotFound") } }));
      this.registerRoute("DELETE", path, (request, response, caller, fastifyRequest) => this.deleteLocalFile(response, route(request, fastifyRequest), caller!), routeSchema(`delete${operationPrefix}`, { summary: `删除会话${kind === "artifact" ? "产物" : "附件"}`, description: `删除当前成员会话中的${kind === "artifact" ? "产物" : "附件"}。`, params, response: { 200: jsonResponse(Type.Ref("LocalFileDeleteEnvelope")), 401: problemResponse("Unauthorized"), 404: problemResponse("NotFound") } }));
    };
    fileItem("attachment", "attachment_id", "Attachment", ConversationFileParams);
    fileItem("artifact", "artifact_id", "Artifact", ConversationArtifactParams);

    this.registerRoute("GET", "/api/agent/grants/experts", (_request, response, caller) => this.listExperts(response, caller!), routeSchema("listAuthorizedExperts", { summary: "列出已授权专家", description: "列出当前成员在本机已装载的专家投影。", response: { 200: jsonResponse(Type.Ref("ExpertListEnvelope")) } }));
    this.registerRoute("GET", "/api/agent/grants/solutions", (_request, response, caller) => this.listSolutions(response, caller!), routeSchema("listAuthorizedSolutions", { summary: "列出已授权方案", description: "列出当前成员在本机已装载的方案投影。", response: { 200: jsonResponse(Type.Ref("SolutionListEnvelope")) } }));
    this.registerRoute("GET", "/api/agent/grants/snapshots", (_request, response, caller) => this.listSnapshots(response, caller!), routeSchema("listFrozenSnapshots", { summary: "列出冻结快照", description: "列出当前成员本地缓存的员工执行快照。", response: { 200: jsonResponse(Type.Ref("SnapshotListEnvelope")) } }));
    this.registerRoute("GET", "/api/agent/grants/readiness", (_request, response, caller) => this.readiness(response, caller!), routeSchema("grantsReadiness", { summary: "检查授权执行就绪状态", description: "检查 Agent runtime 和当前授权专家是否可以执行。", response: { 200: jsonResponse(Type.Ref("ReadinessEnvelope")) } }));
    this.registerRoute("GET", "/api/agent/grants/experts/:employee_id/readiness", (_request, response, caller, fastifyRequest) => this.expertReadiness(response, (fastifyRequest?.params as { employee_id: string }).employee_id, caller!), routeSchema("expertReadiness", { summary: "检查专家就绪状态", description: "检查指定授权专家的本地执行条件。", params: ExpertParams, response: { 200: jsonResponse(Type.Ref("ExpertReadinessEnvelope")) } }));
    this.registerRoute("POST", "/api/agent/grants/sync", (request, response, caller) => this.syncGrants(request, response, caller!), routeSchema("syncGrants", { summary: "同步授权配置", description: "主动从 Manager 拉取当前成员的增量授权配置并更新本地投影。", body: Type.Ref("GrantSyncRequest"), response: { 200: jsonResponse(Type.Ref("GrantSyncEnvelope")), 503: problemResponse("ManagerUnavailable") } }));
    this.registerRoute("GET", "/api/agent/work-records", (request, response, caller) => {
      this.writeJson(response, 200, this.workRecords.history(caller!, new URL(request.url ?? "/", "http://localhost").searchParams));
    }, routeSchema("listWorkRecords", { summary: "读取本机员工工作历史", description: "owner 隔离的实际 promptParticipant 观察及明确 provenance 的旧 Pi 历史，不是 Run/Task 执行状态机。按 occurred_at DESC/稳定创建序号 DESC，before 向更早翻页。精确 UTC [window_start,window_end)；未知旧时间为 null、不虚构开始/结束/用量。meta.after 保持第一页水位，随后轮询已看到记录的终态更新。正文摘要仅从 Pi 读取脱敏，不保存第二份正文，不上传。", querystring: WorkHistoryQuery, response: { 200: jsonResponse(Type.Ref("WorkHistoryEnvelope")) } }));
    this.registerRoute("GET", "/api/agent/work-records/changes", (request, response, caller) => {
      this.writeJson(response, 200, this.workRecords.changes(caller!, new URL(request.url ?? "/", "http://localhost").searchParams));
    }, routeSchema("listWorkRecordChanges", { summary: "增量轮询工作记录更新与删除", description: "按单调变更序号正序返回最新 upsert/delete；同 ID 的 active→final 和同毫秒变化均可见，非逐事件回放。after 使用 history.meta.after 或上次 page.next_cursor；空页仍可续用。只允许 owner/employee 过滤，不接受时间/会话/结果过滤，删除仅留不可定位会话的 opaque ID tombstone。keyset 非内容快照，UI 按 ID upsert/remove；时间过滤历史的 UI 在相同 employee scope 变更上更新筛选。", querystring: WorkChangesQuery, response: { 200: jsonResponse(Type.Ref("WorkChangesEnvelope")) } }));
    this.registerRoute("GET", "/api/agent/usage/statistics", (request, response, caller) => {
      this.writeJson(response, 200, this.usageStatistics.statistics(caller!, new URL(request.url ?? "/", "http://localhost").searchParams));
    }, routeSchema("getUsageStatistics", { summary: "读取当前成员本机小时用量统计", description: "直接相加全部 pending/sending/sent/failed 小时 outbox，无重复账本。按执行开始所在 UTC 小时归属，成对 [window_start,window_end) 必须 UTC 整点，不对齐返回 422，均省略为全部；不同于工作历史精确时间。费用 USD 十二位 decimal string，未知总价 null，另给已知小计，最终一次舍入 cents。删除/已上报不缩水，不重新计量旧历史，不补造旧缺失 counters/历史精度，崩溃未结算不猜计量。", querystring: UsageStatisticsQuery, response: { 200: jsonResponse(Type.Ref("UsageStatisticsEnvelope")) } }));
    this.registerRoute("GET", "/api/agent/usage/outbox", (_request, response, caller) => this.listOutbox(response, caller!), routeSchema("listUsageOutbox", { summary: "列出用量上报队列", description: "查看本地待上报或失败的脱敏用量摘要。", response: { 200: jsonResponse(Type.Ref("UsageOutboxListEnvelope")) } }));
    this.registerRoute("POST", "/api/agent/usage/flush", (request, response, caller) => this.flushUsage(request, response, caller!), routeSchema("flushUsage", { summary: "刷新用量上报", description: "将本地脱敏用量摘要尽力上报到 Manager。", body: Type.Ref("UsageFlushRequest"), response: { 200: jsonResponse(Type.Ref("UsageFlushEnvelope")), 503: problemResponse("ManagerUnavailable") } }));
    this.registerRoute("GET", "/api/agent/marketplace/templates", (_request, response, caller) => this.listMarketplaceTemplates(response, caller!), routeSchema("listMarketplaceTemplates", { summary: "列出专家市场模板", description: "从 Manager 拉取当前成员可见的专家模板。", response: { 200: jsonResponse(Type.Ref("MarketplaceTemplateListEnvelope")), 503: problemResponse("ManagerUnavailable") } }));
    this.registerRoute("GET", "/api/agent/marketplace/templates/:template_id", (_request, response, caller, fastifyRequest) => this.listMarketplaceTemplates(response, caller!, (fastifyRequest?.params as { template_id: string }).template_id), routeSchema("getMarketplaceTemplate", { summary: "获取专家市场模板", description: "获取当前成员可见的单个专家模板。", params: Type.Object({ template_id: Type.String({ minLength: 1, description: "专家模板 ID。" }) }, { additionalProperties: false }), response: { 200: jsonResponse(Type.Ref("MarketplaceTemplateEnvelope")), 404: problemResponse("NotFound"), 503: problemResponse("ManagerUnavailable") } }));
    this.registerRoute("GET", "/api/agent/knowledge-bases", (_request, response) => this.listKnowledgeBases(response), routeSchema("listKnowledgeBases", { summary: "查询已移除的知识库接口", description: "该 Agent 知识库旧接口已移除，请改用 Pi 知识工具。", response: { 410: problemResponse("Gone") } }));
    for (const [path, operationId, params] of [
      ["/api/agent/knowledge-bases/:knowledge_base_id/:kind", "knowledgeReadModel", KnowledgeBaseParams],
      ["/api/agent/knowledge-bases/:knowledge_base_id/:kind/:resource_id", "knowledgeReadModelResource", KnowledgeResourceParams],
    ] as const) this.registerRoute("GET", path, (_request, response) => this.listKnowledgeReadModel(response), routeSchema(operationId, { summary: "查询已移除的知识库读模型", description: "该 Agent 知识库旧读模型已移除，请改用 Pi 知识工具。", params, response: { 410: problemResponse("Gone") } }));
    this.registerRoute("GET", "/api/agent/org/tree", (request, response, caller) => this.orgTree(response, caller!), routeSchema("orgTree", { summary: "获取组织树", description: "从 Manager 拉取当前成员可见的组织结构投影。", response: { 200: jsonResponse(Type.Ref("OrgTreeEnvelope")), 503: problemResponse("ManagerUnavailable") } }));
    this.registerRoute("GET", "/api/agent/office/scene", (_request, response, caller) => this.officeScene(response, caller!), routeSchema("officeScene", { summary: "获取办公场景", description: "返回本地专家工作状态和当前会话摘要。", response: { 200: jsonResponse(Type.Ref("OfficeSceneEnvelope")) } }));
    this.registerRoute("GET", "/api/agent/office/feed", (_request, response, caller) => this.officeFeed(response, caller!), routeSchema("officeFeed", { summary: "获取办公动态", description: "返回本地已配置会话调度的动态摘要。", response: { 200: jsonResponse(Type.Ref("OfficeFeedEnvelope")) } }));

    const gone = (_request: IncomingMessage, _response: ServerResponse) => { throw new HttpProblem(410, "gone", "This Agent endpoint was removed; use Manager-authorized read projections or the Pi prompt API"); };
    for (const path of ["/api/agent/conversations/:conversation_id/group-dispatch", "/api/agent/conversations/:conversation_id/terminal/execute", "/api/agent/recruitments", "/api/agent/recruitments/*", "/api/agent/knowledge-bases/*"]) this.registerRoute(["GET", "POST", "PUT", "PATCH", "DELETE"], path, gone, routeSchema("removedAgentEndpoint", { hide: true, response: { 410: problemResponse("Gone") } }));
  }

  private registerRoute(method: string | string[], url: string, handler: AgentRouteHandler, schema: Record<string, unknown>, authenticated = true): void {
    const routeSchemaWithAuth = { ...schema, security: authenticated ? [{ bearerAuth: [] }] : [] };
    this.app.route({
      method: method as never,
      url,
      schema: routeSchemaWithAuth as never,
      handler: async (request, reply) => {
        const raw = request.raw as BufferedRequest & { __params?: Record<string, string> };
        raw[FASTIFY_BODY] = request.body;
        reply.hijack();
        try {
          let caller: AuthenticatedCaller | undefined;
          if (authenticated) {
            try { caller = await this.options.authenticate(raw); } catch { throw new HttpProblem(401, "unauthenticated", "Authentication is required"); }
            if (!caller.callerId || typeof caller.tenantId !== "string" || !caller.tenantId.trim() || !(caller.userId ?? caller.callerId) || (caller.claims && caller.claims.tenant_id !== caller.tenantId)) throw new HttpProblem(401, "unauthenticated", "Authenticated tenant and member are required");
          }
          await handler(raw, reply.raw, caller, request);
        } catch (error) {
          this.errors += 1;
          if (!(error instanceof EventCursorStaleError)) this.options.logger?.error(error);
          this.writeError(reply.raw, error, String(request.id));
        }
      },
    });
  }

  private fastifyError(error: unknown): unknown {
    const candidate = error as { code?: string; statusCode?: number; validation?: unknown };
    if (candidate.code === "FST_ERR_CTP_INVALID_JSON_BODY") return new HttpProblem(400, "invalid_json", "Request body must be a JSON object");
    if (candidate.code === "FST_ERR_CTP_BODY_TOO_LARGE" || candidate.statusCode === 413) return new HttpProblem(413, "request_too_large", "Request body is too large");
    if (candidate.code === "FST_ERR_VALIDATION") return new HttpProblem(422, "validation_error", "Request validation failed", candidate.validation);
    return error;
  }

  private async resolveTenantByAccount(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.options.managerClient?.resolveTenantByAccount) throw new HttpProblem(503, "manager_unavailable", "Manager tenant resolution is not configured");
    const body = await this.readJson(request);
    const account = this.stringField(body.account, "account", 256);
    const enterprise = typeof body.enterprise === "string" && body.enterprise.trim() ? this.stringField(body.enterprise, "enterprise", 200) : undefined;
    try {
      const payload = await this.options.managerClient.resolveTenantByAccount(account, enterprise);
      const tenantId = payload && typeof payload === "object" ? (payload as { data?: { tenant_id?: unknown } }).data?.tenant_id : undefined;
      if (typeof tenantId !== "string" || !tenantId.trim()) throw new ManagerUnavailableError("Manager returned an invalid tenant resolution");
      this.writeJson(response, 200, payload);
    } catch (error) {
      if (error instanceof ManagerAuthError) {
        const body = error.body && typeof error.body === "object" ? error.body as Record<string, unknown> : undefined;
        throw new HttpProblem(error.status, typeof body?.code === "string" ? body.code : "tenant_resolution_failed", typeof body?.detail === "string" ? body.detail : "Manager tenant resolution failed", body?.errors);
      }
      if (error instanceof ManagerUnavailableError) throw new HttpProblem(503, "manager_unavailable", "Manager tenant resolution is unavailable");
      throw error;
    }
  }

  private validateAuthTenant(payload: unknown, expected: string): void {
    const data = payload && typeof payload === "object" ? (payload as { data?: { claims?: { tenant_id?: unknown } } }).data : undefined;
    if (!expected.trim() || data?.claims?.tenant_id !== expected) throw new ManagerUnavailableError("Manager returned an invalid Agent tenant identity");
  }

  /** 公开认证端点的企业解析：显式 tenant_id 优先；否则按 account/enterprise 让 Manager 解析。 */
  private async resolveAuthTenant(tenantId: string | null, account: string, enterprise: string | null): Promise<string> {
    const explicit = tenantId?.trim();
    if (explicit) return explicit;
    if (!this.options.managerClient?.resolveTenantByAccount) throw new HttpProblem(503, "manager_unavailable", "Manager tenant resolution is not configured");
    try {
      const payload = await this.options.managerClient.resolveTenantByAccount(account, enterprise ?? undefined);
      const resolved = payload && typeof payload === "object" ? (payload as { data?: { tenant_id?: unknown } }).data?.tenant_id : undefined;
      if (typeof resolved !== "string" || !resolved.trim()) throw new ManagerUnavailableError("Manager returned an invalid tenant resolution");
      return resolved;
    } catch (error) {
      if (error instanceof ManagerAuthError) {
        const body = error.body && typeof error.body === "object" ? error.body as Record<string, unknown> : undefined;
        throw new HttpProblem(error.status, typeof body?.code === "string" ? body.code : "tenant_resolution_failed", typeof body?.detail === "string" ? body.detail : "Manager tenant resolution failed", body?.errors);
      }
      if (error instanceof ManagerUnavailableError) throw new HttpProblem(503, "manager_unavailable", "Manager tenant resolution is unavailable");
      throw error;
    }
  }

  private async login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.options.managerClient?.login) throw new HttpProblem(503, "manager_unavailable", "Manager authentication is not configured");
    const body = await this.readJson(request);
    const account = this.stringField(body.account, "account", 256);
    const password = this.stringField(body.password, "password", 512);
    const tenantId = await this.resolveAuthTenant(this.optionalString(body.tenant_id, "tenant_id"), account, this.optionalString(body.enterprise, "enterprise"));
    try {
      const payload = await this.options.managerClient.login({ tenant_id: tenantId, account, password });
      this.validateAuthTenant(payload, tenantId);
      this.writeJson(response, 200, payload);
    } catch (error) {
      if (error instanceof ManagerAuthError) {
        const body = error.body && typeof error.body === "object" ? error.body as Record<string, unknown> : undefined;
        throw new HttpProblem(error.status, typeof body?.code === "string" ? body.code : "authentication_failed", typeof body?.detail === "string" ? body.detail : "Manager authentication failed", body?.errors);
      }
      if (error instanceof ManagerUnavailableError) throw new HttpProblem(503, "manager_unavailable", "Manager authentication is unavailable");
      throw error;
    }
  }

  private async resetPassword(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.options.managerClient?.ownerReset) throw new HttpProblem(503, "manager_unavailable", "Manager authentication is not configured");
    const body = await this.readJson(request);
    const account = this.stringField(body.account, "account", 256);
    const input = {
      tenant_id: await this.resolveAuthTenant(this.optionalString(body.tenant_id, "tenant_id"), account, this.optionalString(body.enterprise, "enterprise")),
      account,
      old_password: this.stringField(body.old_password, "old_password", 512),
      new_password: this.stringField(body.new_password, "new_password", 512),
    };
    try {
      const payload = await this.options.managerClient.ownerReset(input);
      this.validateAuthTenant(payload, input.tenant_id);
      this.writeJson(response, 200, payload);
    } catch (error) {
      if (error instanceof ManagerAuthError) {
        const body = error.body && typeof error.body === "object" ? error.body as Record<string, unknown> : undefined;
        throw new HttpProblem(error.status, typeof body?.code === "string" ? body.code : "password_reset_failed", typeof body?.detail === "string" ? body.detail : "Manager password reset failed", body?.errors);
      }
      if (error instanceof ManagerUnavailableError) throw new HttpProblem(503, "manager_unavailable", "Manager authentication is unavailable");
      throw error;
    }
  }

  private listConversations(response: ServerResponse, query: URLSearchParams, caller: AuthenticatedCaller): void {
    validateReadQuery(query, ["limit", "cursor"]);
    const limit = readPageLimit(query);
    const cursor = query.get("cursor") ?? undefined;
    const result = this.options.store.listConversations(limit, cursor, caller.tenantId, caller.userId ?? caller.callerId);
    this.writeJson(response, 200, { data: result.items.map((item) => this.conversationReads.metadata(item.id, caller)), page: { next_cursor: result.nextCursor, has_more: result.hasMore } });
  }

  private groupParticipantSeeds(employeeIds: readonly string[], caller: AuthenticatedCaller): GroupParticipantSeed[] {
    const memberId = caller.userId ?? caller.callerId;
    const snapshots = this.options.store.listSnapshots(caller.tenantId, memberId);
    return [...new Set(employeeIds)].map((employeeId) => {
      this.requireAuthorizedEmployee(employeeId, caller);
      const snapshot = snapshots.find((item) => item.employee_id === employeeId);
      if (!snapshot) throw new HttpProblem(403, "employee_not_authorized", "Employee is not authorized locally");
      return { id: employeeId, version: snapshot.version };
    });
  }

  private async createResolvedGroup(response: ServerResponse, caller: AuthenticatedCaller, input: ResolvedGroupConversation): Promise<void> {
    await this.groupCreation.create(input, caller);
    this.writeJson(response, 201, { data: this.conversationReads.metadata(input.id, caller) });
  }

  private async createCustomGroup(request: IncomingMessage, response: ServerResponse, caller: AuthenticatedCaller): Promise<void> {
    const body = await this.readJson(request);
    if (!Check({ GroupOrchestration, ConversationPermissionMode: PermissionMode }, CustomGroupCreateRequest, body)) throw new HttpProblem(422, "invalid_group_configuration", "Custom group fields do not match the documented schema");
    const input = body as unknown as { title: string; description?: string | null; member_employee_ids: string[]; coordinator_employee_id: string; orchestration: unknown };
    const orchestration = validateCustomGroup(input);
    const memberId = caller.userId ?? caller.callerId;
    const id = typeof body.id === "string" ? body.id : randomUUID();
    this.groupCreation.assertAvailable(id, caller.tenantId!, memberId);
    await this.createResolvedGroup(response, caller, {
      id,
      title: input.title.trim(),
      labels: [],
      description: input.description?.trim() || null,
      orchestration,
      coordinatorEmployeeId: input.coordinator_employee_id,
      solutionRef: null,
      schedule: null,
      permissionMode: parsePermissionMode(body.permission_mode),
      tenantId: caller.tenantId!,
      memberId,
      participants: this.groupParticipantSeeds(input.member_employee_ids, caller),
    });
  }

  private async createConversation(request: IncomingMessage, response: ServerResponse, caller: AuthenticatedCaller): Promise<void> {
    const body = await this.readJson(request);
    if (["description", "member_employee_ids", "orchestration"].some(key => key in body)) throw new HttpProblem(422, "invalid_group_configuration", "Use the custom-group endpoint for custom group configuration");
    const title = body.title === undefined || body.title === null ? null : this.stringField(body.title, "title", 200);
    const kind = body.kind === undefined ? "chat" : this.stringField(body.kind, "kind", 64);
    const labels = body.labels === undefined ? [] : this.stringArray(body.labels, "labels", 32);
    const entryEmployeeId = this.optionalString(body.entry_employee_id, "entry_employee_id");
    let coordinatorEmployeeId = this.optionalString(body.coordinator_employee_id, "coordinator_employee_id");
    const solutionRef = this.optionalString(body.solution_instance_id, "solution_instance_id");
    const permissionMode = parsePermissionMode(body.permission_mode);
    const memberId = caller.userId ?? caller.callerId;
    const id = typeof body.id === "string" && body.id.length > 0 ? body.id : randomUUID();
    let schedule = null;
    if (body.schedule !== undefined && body.schedule !== null) schedule = this.parseSchedule(body.schedule);

    const existing = this.options.store.getConversationMetadata(id);
    if (kind !== "group" && existing) {
      if (existing.tenant_id === caller.tenantId && existing.member_id === memberId) throw new HttpProblem(409, "conversation_exists", "Conversation already exists");
      throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    }
    if (kind === "group") {
      this.groupCreation.assertAvailable(id, caller.tenantId!, memberId);
      if (entryEmployeeId) throw new HttpProblem(422, "invalid_group_employee", "Group conversations use coordinator_employee_id");
      const solution = solutionRef ? this.options.store.listSolutions(caller.tenantId, memberId).find((item) => item.solution_instance_id === solutionRef) : undefined;
      if (solutionRef && !solution) throw new HttpProblem(403, "solution_not_authorized", "Solution is not authorized locally");
      const solutionRoster = solution && Array.isArray(solution.expert_employee_ids)
        ? [...new Set(solution.expert_employee_ids.filter((employeeId): employeeId is string => typeof employeeId === "string"))]
        : [];
      const availableRoster = this.options.store.listLoadedExperts(caller.tenantId, memberId)
        .filter((expert) => !expert.revoked)
        .map((expert) => expert.employee_id);
      const solutionCoordinator = solution && typeof solution.coordinator_employee_id === "string" ? solution.coordinator_employee_id : undefined;
      if (solutionCoordinator && coordinatorEmployeeId && coordinatorEmployeeId !== solutionCoordinator) throw new HttpProblem(403, "coordinator_not_authorized", "Coordinator does not match the authorized solution");
      if (!coordinatorEmployeeId) coordinatorEmployeeId = solutionCoordinator ?? solutionRoster[0] ?? availableRoster[0] ?? null;
      if (!coordinatorEmployeeId) throw new HttpProblem(403, "coordinator_not_authorized", "No authorized employee is available as coordinator");
      if (solution ? !solutionRoster.includes(coordinatorEmployeeId) : !availableRoster.includes(coordinatorEmployeeId)) {
        throw new HttpProblem(403, "coordinator_not_authorized", solution ? "Coordinator is not in the authorized solution roster" : "Coordinator is not in the authorized local roster");
      }
      await this.createResolvedGroup(response, caller, {
        id,
        title,
        labels,
        coordinatorEmployeeId,
        solutionRef,
        schedule,
        permissionMode,
        tenantId: caller.tenantId!,
        memberId,
        participants: this.groupParticipantSeeds(solution ? solutionRoster : availableRoster, caller),
      });
      return;
    }

    if (coordinatorEmployeeId || solutionRef) throw new HttpProblem(422, "invalid_conversation_collaboration", "Only group conversations accept coordinator or solution references");
    if (entryEmployeeId) this.requireAuthorizedEmployee(entryEmployeeId, caller);
    this.options.store.createConversation({
      id, title, kind, labels, state: "active", schedule,
      entryEmployeeId, coordinatorEmployeeId, solutionRef, permissionMode,
      tenantId: caller.tenantId,
      memberId,
    });
    try {
      await this.options.host.initializeConversationParticipants(id, caller);
    } catch (error) {
      await this.options.host.delete(id, caller.tenantId!, memberId).catch(() => undefined);
      throw error;
    }
    this.writeJson(response, 201, { data: this.conversationReads.metadata(id, caller) });
  }

  private resolvePromptTargets(conversation: ReturnType<AgentSqliteStore["getConversation"]>, caller: AuthenticatedCaller, mentions: string[]): string[] {
    if (!conversation) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    const coordinator = conversation.entryEmployeeId ?? conversation.coordinatorEmployeeId;
    if (conversation.kind !== "group") {
      if (mentions.length > 0) throw new HttpProblem(422, "invalid_mentions", "mentions are only supported for group conversations");
      if (!coordinator) throw new HttpProblem(403, "employee_not_authorized", "Conversation requires a locally authorized employee snapshot");
      return [coordinator];
    }
    if (mentions.length === 0) {
      if (!coordinator) throw new HttpProblem(403, "coordinator_not_authorized", "Group conversation has no coordinator");
      return [coordinator];
    }
    const memberId = caller.userId ?? caller.callerId;
    const participants = this.options.store.listConversationParticipants(conversation.id);
    if (conversation.orchestration && !participants.length) throw new HttpProblem(403, "employee_not_authorized", "Custom group participant index is missing");
    const solution = conversation.solutionRef
      ? this.options.store.listSolutions(caller.tenantId, memberId).find((item) => item.solution_instance_id === conversation.solutionRef)
      : undefined;
    const roster = new Set(participants.length > 0
      ? participants.map((participant) => participant.employee_id)
      : solution && Array.isArray(solution.expert_employee_ids)
        ? solution.expert_employee_ids.filter((employeeId): employeeId is string => typeof employeeId === "string")
        : this.options.store.listLoadedExperts(caller.tenantId, memberId).filter((expert) => !expert.revoked).map((expert) => expert.employee_id));
    const experts = this.options.store.listLoadedExperts(caller.tenantId, memberId);
    const targets = [...new Set(mentions)].map((handle) => experts.find((expert) => expert.handle === handle)?.employee_id);
    if (targets.some((employeeId) => !employeeId || !roster.has(employeeId))) throw new HttpProblem(403, "employee_not_authorized", "Mentioned employee is not in the authorized group roster");
    return targets as string[];
  }

  private requireAuthorizedEmployee(employeeId: string, caller: AuthenticatedCaller): void {
    const memberId = caller.userId ?? caller.callerId;
    const expert = this.options.store.listLoadedExperts(caller.tenantId, memberId).find((item) => item.employee_id === employeeId && !item.revoked);
    if (!expert || !this.options.store.listSnapshots(caller.tenantId, memberId).some((snapshot) => snapshot.employee_id === employeeId && snapshot.version === expert.version)) {
      throw new HttpProblem(403, "employee_not_authorized", "Employee is not authorized locally");
    }
  }

  private requireOwnedConversation(conversationId: string, caller: AuthenticatedCaller): void {
    if (!caller.tenantId) throw new HttpProblem(401, "unauthenticated", "Authenticated tenant is required");
    if (!this.options.store.getOwnedConversation(conversationId, caller.tenantId, caller.userId ?? caller.callerId)) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
  }

  private getConversation(response: ServerResponse, conversationId: string, caller: AuthenticatedCaller): void {
    this.writeJson(response, 200, { data: this.conversationReads.metadata(conversationId, caller) });
  }

  private async updateConversation(request: IncomingMessage, response: ServerResponse, conversationId: string, caller: AuthenticatedCaller): Promise<void> {
    const body = await this.readJson(request);
    const patch: Parameters<AgentSqliteStore["updateConversation"]>[1] = {};
    if (body.title !== undefined) patch.title = body.title === null ? null : this.stringField(body.title, "title", 200);
    if (body.kind !== undefined) patch.kind = this.stringField(body.kind, "kind", 64);
    if (body.labels !== undefined) patch.labels = this.stringArray(body.labels, "labels", 32);
    if (body.schedule !== undefined) patch.schedule = body.schedule === null ? null : this.parseSchedule(body.schedule);
    if (body.permission_mode !== undefined) patch.permissionMode = parsePermissionMode(body.permission_mode);
    this.requireOwnedConversation(conversationId, caller);
    const current = this.options.store.getConversationMetadata(conversationId)!;
    if (["description", "member_employee_ids", "orchestration"].some(key => key in body)
      || (current.orchestration && (["coordinator_employee_id", "entry_employee_id", "solution_instance_id"].some(key => key in body) || (patch.kind && patch.kind !== "group")))) {
      throw new HttpProblem(422, "invalid_group_configuration", "Group configuration is immutable after creation");
    }
    if (body.last_read_entry_id !== undefined) patch.lastReadEntryId = this.conversationReads.readPointer(conversationId, caller, body.last_read_entry_id);
    const updated = this.options.store.updateConversation(conversationId, patch);
    if (!updated) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: this.conversationReads.metadata(conversationId, caller) });
  }

  private getConversationState(response: ServerResponse, conversationId: string, caller: AuthenticatedCaller): void {
    const metadata = this.options.store.getOwnedConversationMetadata(conversationId, caller.tenantId!, caller.userId ?? caller.callerId);
    if (!metadata) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: { conversation_id: metadata.id, state: metadata.state, prompting: this.options.host.isPrompting(conversationId) } });
  }

  private async getConversationContext(response: ServerResponse, conversationId: string, caller: AuthenticatedCaller): Promise<void> {
    this.requireOwnedConversation(conversationId, caller);
    this.writeJson(response, 200, { data: await this.options.host.getConversationContext(conversationId, caller) });
  }

  private async updateConversationContext(request: IncomingMessage, response: ServerResponse, conversationId: string, caller: AuthenticatedCaller): Promise<void> {
    this.requireOwnedConversation(conversationId, caller);
    const body = await this.readJson(request);
    const thinkingLevel = parseThinkingLevel(body.thinking_level);
    this.writeJson(response, 200, { data: await this.options.host.setThinkingLevel(conversationId, thinkingLevel, caller) });
  }

  private async updateConversationState(request: IncomingMessage, response: ServerResponse, conversationId: string, caller: AuthenticatedCaller): Promise<void> {
    const body = await this.readJson(request);
    const state = this.stringField(body.state, "state", 32) as ConversationState;
    if (!["draft", "active", "paused", "muted", "archived"].includes(state)) throw new HttpProblem(422, "invalid_state", "Unsupported conversation state");
    this.requireOwnedConversation(conversationId, caller);
    const updated = this.options.store.updateConversation(conversationId, { state });
    if (!updated) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: this.conversationReads.metadata(conversationId, caller) });
  }

  private async deleteConversation(response: ServerResponse, conversationId: string, caller: AuthenticatedCaller): Promise<void> {
    if (!(await this.options.host.delete(conversationId, caller.tenantId!, caller.userId ?? caller.callerId))) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: { deleted: true } });
  }

  private listExperts(response: ServerResponse, caller: AuthenticatedCaller): void { this.writeJson(response, 200, { data: this.options.store.listLoadedExperts(caller.tenantId, caller.userId ?? caller.callerId).map((expert) => ({ ...expert, ...employeeDisplay(expert) })), page: { next_cursor: null, has_more: false } }); }
  private listSolutions(response: ServerResponse, caller: AuthenticatedCaller): void { this.writeJson(response, 200, { data: this.options.store.listSolutions(caller.tenantId, caller.userId ?? caller.callerId), page: { next_cursor: null, has_more: false } }); }
  private async listMarketplaceTemplates(response: ServerResponse, caller: AuthenticatedCaller, templateId?: string): Promise<void> {
    if (!this.options.managerClient?.listMarketplaceTemplates) throw new HttpProblem(503, "manager_unavailable", "Marketplace catalog is unavailable");
    let templates: MarketplaceTemplate[];
    try {
      templates = await this.options.managerClient.listMarketplaceTemplates(caller);
    } catch (error) {
      if (error instanceof ManagerAuthorizationError) throw new HttpProblem(error.status, error.status === 401 ? "unauthenticated" : "forbidden", error.message);
      if (error instanceof ManagerUnavailableError) throw new HttpProblem(503, "manager_unavailable", "Marketplace catalog is unavailable");
      throw error;
    }
    if (templateId) {
      const template = templates.find((item) => item.template_id === templateId);
      if (!template) throw new HttpProblem(404, "marketplace_template_not_found", "Marketplace template not found");
      return this.writeJson(response, 200, { data: template });
    }
    this.writeJson(response, 200, { data: templates, page: { next_cursor: null, has_more: false } });
  }
  private listKnowledgeBases(response: ServerResponse): void { throw new HttpProblem(410, "gone", "Agent knowledge base endpoints were removed; use the Pi knowledge tools"); }
  private listKnowledgeReadModel(response: ServerResponse): void { throw new HttpProblem(410, "gone", "Agent knowledge read endpoints were removed; use the Pi knowledge tools"); }
  private listSnapshots(response: ServerResponse, caller: AuthenticatedCaller): void { this.writeJson(response, 200, { data: this.options.store.listSnapshots(caller.tenantId, caller.userId ?? caller.callerId), page: { next_cursor: null, has_more: false } }); }
  private listOutbox(response: ServerResponse, caller: AuthenticatedCaller): void { this.writeJson(response, 200, { data: this.options.store.listUsageOutbox(caller.tenantId, caller.userId ?? caller.callerId), page: { next_cursor: null, has_more: false } }); }

  private async flushUsage(request: IncomingMessage, response: ServerResponse, caller: AuthenticatedCaller): Promise<void> {
    if (!this.options.usageFlush) throw new HttpProblem(503, "manager_unavailable", "Manager usage upload is not configured");
    const body = await this.readJson(request);
    const limit = body.limit === undefined ? 50 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpProblem(422, "invalid_limit", "limit must be an integer between 1 and 100");
    const result = await this.options.usageFlush.flush(caller, limit);
    if (result.failed.length > 0) throw new HttpProblem(503, "manager_unavailable", "Manager usage upload is unavailable", { failed: result.failed, sent: result.sent });
    this.writeJson(response, 200, { data: result });
  }

  private async syncGrants(request: IncomingMessage, response: ServerResponse, caller: AuthenticatedCaller): Promise<void> {
    if (!this.options.managerClient) throw new HttpProblem(503, "manager_unavailable", "Manager sync is not configured");
    const body = await this.readJson(request);
    const tenantId = this.stringField(body.tenant_id, "tenant_id", 200);
    const memberId = this.stringField(body.member_id, "member_id", 200);
    if (tenantId !== caller.tenantId || memberId !== (caller.userId ?? caller.callerId)) throw new HttpProblem(403, "forbidden", "Sync identity does not match authenticated caller");
    const knownVersions = body.known_versions === undefined ? {} : this.objectField(body.known_versions, "known_versions");
    try {
      const config = normalizeAuthorizedConfig(await this.options.managerClient.pullAuthorizedConfig(caller, knownVersions as Record<string, string>), caller.tenantId, caller.userId ?? caller.callerId);
      const snapshots = config.snapshots ?? (this.options.managerClient.pullSnapshots ? await this.options.managerClient.pullSnapshots(caller, config.experts ?? []) : []);
      const memberId = caller.userId ?? caller.callerId;
      const skillPackagesAuthoritative = config.skill_packages !== undefined;
      const signedPackages = config.skill_packages ?? [];
      const envVerification = skillSigningVerificationFromEnv();
      // A present Manager key set is authoritative, including an explicit
      // empty list.  Do not let the process env or an offline keyring revive
      // packages after the snapshot/config revoked every signing key.
      const verification = skillSigningVerificationForSnapshot(
        config as unknown as Record<string, unknown>, envVerification,
      );
      // Verify every envelope before changing projections or cache. Missing key means
      // package sync is disabled, not an invitation to accept unsigned content.
      if (signedPackages.length && !verification.publicKeys?.length && (!verification.publicKey || !verification.keyId)) throw new HttpProblem(503, "skill_signing_unconfigured", "Signed skill verification is not configured");
      if (signedPackages.length) {
        try {
          for (const envelope of signedPackages) {
            verifySignedSkillPackage(envelope, { ...verification, tenantId: caller.tenantId, memberId });
          }
        } catch (error) {
          if (error instanceof SkillVerificationError) throw new HttpProblem(503, "skill_package_invalid", "Manager returned an invalid signed skill package");
          throw error;
        }
      }
      const result = this.options.store.replaceProjections(config.experts ?? [], config.solutions ?? [], snapshots, config.revoked_ids ?? [], { tenantId: caller.tenantId!, memberId });
      const hasNewSigningKeySet = Array.isArray(config.skill_signing_keys) && config.skill_signing_keys.length > 0;
      if ((skillPackagesAuthoritative || hasNewSigningKeySet) && this.options.skillCache && (signedPackages.length === 0 || verification.publicKeys !== undefined || (verification.publicKey && verification.keyId))) {
        const experts = this.options.store.listLoadedExperts(caller.tenantId, memberId);
        const currentEmployeeIds = new Set(experts.filter((expert) => !expert.revoked).map((expert) => expert.employee_id));
        const refs = experts.filter((expert) => currentEmployeeIds.has(expert.employee_id)).flatMap((expert) => {
          const values = expert.skills;
          return Array.isArray(values) ? values.filter((ref): ref is string => typeof ref === "string") : [];
        });
        refs.push(...this.options.store.listSnapshots(caller.tenantId, memberId).filter((snapshot) => currentEmployeeIds.has(snapshot.employee_id)).flatMap((snapshot) => skillRefsForSnapshot(snapshot as { skill_refs?: unknown; skills?: unknown })));
        this.options.skillCache.reconcile({ tenantId: caller.tenantId, memberId }, signedPackages, refs, verification, { authoritative: skillPackagesAuthoritative });
      }
      this.writeJson(response, 200, { data: { ok: true, ...result } });
    } catch (error) {
      if (error instanceof ManagerAuthorizationError) throw new HttpProblem(error.status, error.status === 401 ? "unauthenticated" : "forbidden", error.message);
      if (error instanceof ManagerUnavailableError || error instanceof TypeError) throw new HttpProblem(503, "manager_unavailable", "Manager sync is unavailable");
      throw error;
    }
  }

  private async readiness(response: ServerResponse, caller: AuthenticatedCaller): Promise<void> {
    const runtime = (await this.options.runtimeReady?.()) ?? true;
    const state = runtime ? "ready" : "blocked";
    const experts = this.options.store.listLoadedExperts(caller.tenantId, caller.userId ?? caller.callerId).map((expert) => this.expertReadinessValue(expert, runtime, caller));
    this.writeJson(response, 200, { data: { runtime: state, runtime_reason: runtime ? undefined : "Pi runtime is not ready", experts } });
  }

  private async expertReadiness(response: ServerResponse, employeeId: string, caller: AuthenticatedCaller): Promise<void> {
    const id = employeeId;
    const expert = this.options.store.listLoadedExperts(caller.tenantId, caller.userId ?? caller.callerId).find((item) => item.employee_id === id);
    if (!expert) return this.writeJson(response, 200, { data: { employee_id: id, display_name: id, handle: id, available: false, runtime: "unknown", provider: "unknown", skills: [], capabilities: [], reasons: ["Expert is not authorized locally"] } });
    const runtime = (await this.options.runtimeReady?.()) ?? true;
    this.writeJson(response, 200, { data: this.expertReadinessValue(expert, runtime, caller) });
  }

  private expertReadinessValue(expert: LoadedExpertProjection, runtime: boolean, caller: AuthenticatedCaller) {
    const provider = expert.model_policy?.model && expert.model_policy.provider_ref ? "ready" : "blocked";
    const lifecycle = typeof expert.status === "string" && expert.status !== "active" ? "blocked" : "ready";
    const memberId = caller.userId ?? caller.callerId;
    const snapshot = this.options.store.listSnapshots(caller.tenantId, memberId).find((item) => item.employee_id === expert.employee_id && item.version === expert.version);
    let refs: string[] = [];
    let malformedSnapshot = false;
    try {
      refs = snapshot ? skillRefsForSnapshot(snapshot as { skill_refs?: unknown; skills?: unknown }) : skillRefsForSnapshot({ skills: expert.skills });
    } catch {
      // A present but malformed canonical field must not resurrect legacy refs;
      // readiness reports the snapshot as blocked instead of executing fallback.
      malformedSnapshot = Boolean(snapshot);
    }
    let skills: Array<{ ref: string; status: "ready" | "blocked"; reason?: string; version?: string }>;
    try {
      const verification = snapshot
        ? skillSigningVerificationForSnapshot(snapshot as unknown as Record<string, unknown>)
        : skillSigningVerificationFromEnv();
      skills = malformedSnapshot
        ? [{ ref: "snapshot", status: "blocked", reason: "skill_snapshot_invalid" }]
        : caller.tenantId && this.options.skillCache
          ? this.options.skillCache.readinessFor({ tenantId: caller.tenantId, memberId }, refs, verification)
          : refs.map((ref) => ({ ref, status: "blocked", reason: "skill_missing" }));
    } catch { skills = malformedSnapshot ? [{ ref: "snapshot", status: "blocked", reason: "skill_snapshot_invalid" }] : refs.map((ref) => ({ ref, status: "blocked", reason: "skill_invalid_or_expired" })); }
    const missing = skills.filter((skill) => skill.status !== "ready");
    return { employee_id: expert.employee_id, display_name: expert.display_name, handle: expert.handle, available: runtime && provider === "ready" && lifecycle === "ready" && missing.length === 0, runtime: runtime ? "ready" : "blocked", provider, skills, capabilities: [], reasons: [ ...missing.map((skill) => `Required skill ${skill.ref}: ${skill.reason}`), ...(runtime ? [] : ["Pi runtime is not ready"]), ...(lifecycle === "ready" ? [] : ["Manager has not activated this expert"]), ...(provider === "ready" ? [] : ["Manager snapshot has no model provider"]) ] };
  }

  private async orgTree(response: ServerResponse, caller: AuthenticatedCaller): Promise<void> {
    if (!this.options.managerClient) throw new HttpProblem(503, "manager_unavailable", "Organization projection is unavailable");
    try {
      const raw = await this.options.managerClient.getOrgTree(caller);
      const visibleEmployees = new Set(
        this.options.store.listLoadedExperts(caller.tenantId, caller.userId ?? caller.callerId)
          .filter((expert) => !expert.revoked)
          .map((expert) => expert.employee_id),
      );
      this.writeJson(response, 200, { data: projectOrgTree(raw, visibleEmployees) });
    }
    catch (error) {
      if (error instanceof ManagerAuthorizationError) throw new HttpProblem(error.status, error.status === 401 ? "unauthenticated" : "forbidden", error.message);
      throw new HttpProblem(503, "manager_unavailable", "Organization projection is unavailable");
    }
  }

  private async officeScene(response: ServerResponse, caller: AuthenticatedCaller): Promise<void> {
    const memberId = caller.userId ?? caller.callerId;
    const conversations = this.options.store.listConversations(100, undefined, caller.tenantId, memberId).items;
    const activityByEmployee = new Map<string, { conversation_id: string; prompting: boolean; last_activity_at: string | null; last_status: string; last_task: string | null }>();
    for (const conversation of conversations) {
      if (conversation.state === "paused" || conversation.state === "muted" || conversation.state === "archived") continue;
      const host = this.options.host as SessionHost & { getOfficeActivities?: (conversationId: string) => Promise<Array<{ employee_id: string; conversation_id: string; prompting: boolean; last_activity_at: string | null; last_status: string; last_task: string | null }>> };
      const activities = typeof host.getOfficeActivities === "function"
        ? await host.getOfficeActivities(conversation.id)
        : [];
      for (const activity of activities) {
        const previous = activityByEmployee.get(activity.employee_id);
        const previousTime = previous?.last_activity_at ? Date.parse(previous.last_activity_at) : -1;
        const nextTime = activity.last_activity_at ? Date.parse(activity.last_activity_at) : -1;
        if (!previous || activity.prompting || nextTime >= previousTime) activityByEmployee.set(activity.employee_id, activity);
      }
    }
    const employees = this.options.store.listLoadedExperts(caller.tenantId, memberId, true).map((expert) => {
      const activity = activityByEmployee.get(expert.employee_id);
      const inactive = expert.revoked || (typeof expert.status === "string" && expert.status !== "active");
      const status = inactive ? "offline" : activity?.prompting ? "working" : "ready";
      return {
        employee_id: expert.employee_id,
        display_name: expert.display_name,
        ...employeeDisplay(expert),
        status,
        task: status === "working" ? activity?.last_task ?? null : null,
        avatar_url: typeof expert.avatar_url === "string" ? expert.avatar_url : null,
        ...(activity?.last_activity_at ? { last_activity_at: activity.last_activity_at } : {}),
        last_status: inactive ? "offline" : activity?.last_status ?? "idle",
        last_task: activity?.last_task ?? null,
      };
    });
    const summary = {
      total: employees.length,
      working: employees.filter((employee) => employee.status === "working").length,
      ready: employees.filter((employee) => employee.status === "ready").length,
      offline: employees.filter((employee) => employee.status === "offline").length,
    };
    this.writeJson(response, 200, { data: { employees, summary } });
  }

  private officeFeed(response: ServerResponse, caller: AuthenticatedCaller): void {
    const memberId = caller.userId ?? caller.callerId;
    const events = this.options.store.listScheduledConversations()
      .filter((conversation) => conversation.tenantId === caller.tenantId && conversation.memberId === memberId)
      .map((conversation) => ({ type: "conversation_schedule", conversation_id: conversation.id, title: conversation.title ?? conversation.id, schedule: conversation.schedule }));
    this.writeJson(response, 200, { data: { events } });
  }

  private stringField(value: unknown, name: string, max: number): string { if (typeof value !== "string" || value.length === 0 || value.length > max) throw new HttpProblem(422, `invalid_${name}`, `${name} must be a non-empty string <= ${max} characters`); return value; }
  private optionalString(value: unknown, name: string): string | null { if (value === undefined || value === null) return null; return this.stringField(value, name, 256); }
  private stringArray(value: unknown, name: string, maxItems: number): string[] { if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.length > 128)) throw new HttpProblem(422, `invalid_${name}`, `${name} must be an array of strings`); return value as string[]; }
  private objectField(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpProblem(422, `invalid_${name}`, `${name} must be an object`); return value as Record<string, unknown>; }
  private parseSchedule(value: unknown): Record<string, unknown> {
    try { return validateSchedule(value) as unknown as Record<string, unknown>; }
    catch (error) { throw new HttpProblem(422, "invalid_schedule", error instanceof Error ? error.message : "Unsupported schedule"); }
  }

  private async prompt(request: IncomingMessage, response: ServerResponse, conversationId: string, caller: AuthenticatedCaller): Promise<void> {
    const callerId = caller.callerId;
    const key = this.header(request, "idempotency-key");
    if (!key || key.length > 256) throw new HttpProblem(422, "invalid_idempotency_key", "Idempotency-Key is required and must be <= 256 characters");
    const conversation = this.options.store.getOwnedConversation(conversationId, caller.tenantId!, caller.userId ?? caller.callerId);
    if (!conversation) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    const payload = await this.readJson(request);
    const text = payload.text;
    if (typeof text !== "string" || text.trim().length === 0 || text.length > 200_000) {
      throw new HttpProblem(422, "invalid_prompt", "text must be a non-empty string <= 200000 characters");
    }
    const images = this.validateInlineImages(payload.images);
    const attachmentIds = payload.attachment_ids === undefined ? [] : this.stringArray(payload.attachment_ids, "attachment_ids", MAX_PROMPT_IMAGES);
    if (new Set(attachmentIds).size !== attachmentIds.length) throw new HttpProblem(422, "invalid_attachment_ids", "attachment_ids must not contain duplicates");
    const mentions = payload.mentions === undefined ? [] : this.stringArray(payload.mentions, "mentions", 16);
    if (mentions.length > 0 && conversation.kind !== "group") throw new HttpProblem(422, "invalid_mentions", "mentions are only supported for group conversations");
    const targetEmployeeIds = this.resolvePromptTargets(conversation, caller, mentions);
    for (const employeeId of targetEmployeeIds) {
      const expert = this.options.store.listLoadedExperts(caller.tenantId, caller.userId ?? caller.callerId).find((item) => item.employee_id === employeeId && !item.revoked);
      const snapshot = expert ? this.options.store.listSnapshots(caller.tenantId, caller.userId ?? caller.callerId).find((item) => item.employee_id === employeeId && item.version === expert.version) : undefined;
      if (!expert || !snapshot) throw new HttpProblem(403, "employee_not_authorized", "Conversation requires a locally authorized employee snapshot");
      if (typeof expert.status === "string" && expert.status !== "active") throw new HttpProblem(409, "employee_not_runnable", "Manager has not activated this expert");
    }
    // Fingerprint IDs, not mutable attachment bytes, so completed/accepted retries can return their receipt.
    const fingerprint = createHash("sha256").update(JSON.stringify({ text, images, attachment_ids: attachmentIds, mentions })).digest("hex");
    const receipt = this.options.store.reservePrompt({ conversationId, callerId, key, fingerprint });
    if (!receipt.isNew) return this.writeReceipt(response, conversationId, key, receipt.state);

    try {
      const loadedImages: ImageContent[] = [];
      let decodedImageBytes = images.reduce((total, image) => total + Buffer.byteLength(image.data, "base64"), 0);
      for (const attachmentId of attachmentIds) {
        const metadata = this.options.store.getOwnedLocalFile(attachmentId, conversationId, caller.tenantId!, caller.userId ?? caller.callerId);
        if (!metadata) throw new HttpProblem(404, "attachment_not_found", "Attachment not found");
        if (metadata.kind !== "attachment") throw new HttpProblem(422, "invalid_attachment", "Only conversation attachments can be referenced by a prompt");
        // Non-image attachments remain local metadata. Never load their bytes into
        // the Pi image content array; the current Pi prompt contract accepts images only.
        if (!IMAGE_MIMES.has(metadata.mime_type)) continue;
        const loaded = this.options.store.readOwnedLocalFile(attachmentId, conversationId, caller.tenantId!, caller.userId ?? caller.callerId);
        if (!loaded || !hasImageSignature(loaded.record.mime_type, loaded.data)) throw new HttpProblem(422, "invalid_attachment", "Image attachment content does not match its MIME type");
        decodedImageBytes += loaded.data.byteLength;
        loadedImages.push({ type: "image", data: loaded.data.toString("base64"), mimeType: loaded.record.mime_type });
      }
      if (loadedImages.length + images.length > MAX_PROMPT_IMAGES) throw new HttpProblem(422, "invalid_images", "A prompt may contain at most 8 images");
      if (decodedImageBytes > MAX_PROMPT_IMAGE_BYTES) throw new HttpProblem(413, "prompt_images_too_large", "Decoded prompt images exceed 20 MiB");
      const promptImages = [...images, ...loadedImages];
      const worker = this.runPrompt(conversationId, caller, key, receipt.ownerInstance, text, promptImages, mentions, attachmentIds);
      this.promptWorkers.add(worker);
      void worker.finally(() => this.promptWorkers.delete(worker));
      this.writeReceipt(response, conversationId, key, "accepted");
    } catch (error) {
      this.options.store.markUnknown(conversationId, callerId, key, receipt.ownerInstance);
      throw error;
    }
    return;
  }

  private async runPrompt(conversationId: string, caller: AuthenticatedCaller, key: string, ownerInstance: string | undefined, text: string, images: ImageContent[], mentions: string[], attachmentIds: string[]): Promise<void> {
    const callerId = caller.callerId;
    const heartbeat = setInterval(() => this.options.store.renewLease(conversationId, callerId, key, ownerInstance), 10_000);
    try {
      const lastEntryId = await this.options.host.prompt(conversationId, text, images, caller, mentions, { logicalMessageId: key, idempotencyKey: key });
      this.options.store.markLocalFilesReferenced(attachmentIds, conversationId, caller.tenantId!, caller.userId ?? caller.callerId);
      this.options.store.markCompleted(conversationId, callerId, key, lastEntryId, ownerInstance);
    } catch (error) {
      this.options.store.markUnknown(conversationId, callerId, key, ownerInstance);
      this.options.logger?.error(error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async events(request: IncomingMessage, response: ServerResponse, conversationId: string, after: string | null): Promise<void> {
    const requested = after ?? this.header(request, "last-event-id");
    let closed = false;
    let started = false;
    const pending: PiEventEnvelope[] = [];
    const write = (envelope: PiEventEnvelope) => {
      if (closed) return;
      if (!started) return pending.push(envelope), undefined;
      if (!response.writableEnded) {
        const event = serializePiEvent(envelope.event, {
          conversation_id: envelope.conversation_id ?? conversationId,
          ...(envelope.source_ref ? { source_ref: envelope.source_ref } : {}),
          ...(envelope.tool_call_id ? { tool_call_id: envelope.tool_call_id } : {}),
          ...(envelope.source_employee_id ? { source_employee_id: envelope.source_employee_id } : {}),
          ...(envelope.source_employee_display_name ? { source_employee_display_name: envelope.source_employee_display_name } : {}),
          ...(envelope.source_role ? { source_role: envelope.source_role } : {}),
        });
        if (!event) return;
        response.write(`id: ${envelope.id}\nevent: pi\ndata: ${JSON.stringify(event)}\n\n`);
      }
    };
    const unsubscribe = await this.options.host.subscribe(conversationId, write, requested ?? undefined);
    response.writeHead(200, { "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
    response.write(": connected\n\n");
    started = true;
    for (const envelope of pending) write(envelope);
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
    };
    request.once("close", close);
    response.once("close", close);
  }

  private listLocalFiles(response: ServerResponse, route: { conversationId: string; kind?: LocalFileKind }, caller: AuthenticatedCaller): void {
    this.requireOwnedConversation(route.conversationId, caller);
    const items = this.options.store.listOwnedLocalFiles(route.conversationId, caller.tenantId!, caller.userId ?? caller.callerId, route.kind);
    this.writeJson(response, 200, { data: items, page: { next_cursor: null, has_more: false } });
  }

  private async transcribeAudio(request: IncomingMessage, response: ServerResponse, caller: AuthenticatedCaller): Promise<void> {
    if (!this.options.managerClient?.pullSpeechRuntimeConfig) {
      throw new HttpProblem(503, "manager_unavailable", "Manager speech runtime config is not configured");
    }
    const body = await this.readJson(request, MAX_UPLOAD_JSON_BYTES);
    const filename = this.stringField(body.filename, "filename", MAX_LOCAL_FILE_NAME);
    if (filename.includes("/") || filename.includes("\\") || /[\x00-\x1f\x7f]/u.test(filename)) {
      throw new HttpProblem(422, "invalid_filename", "filename must be a safe basename");
    }
    const rawMime = this.stringField(body.mime_type, "mime_type", 128);
    const mimeType = rawMime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!AUDIO_MIMES.has(mimeType)) throw new HttpProblem(422, "invalid_audio_mime_type", "Unsupported audio MIME type");
    const encoded = this.stringField(body.data, "data", Math.ceil(MAX_LOCAL_FILE_BYTES / 3) * 4);
    const audio = decodeBase64(encoded);
    if (!audio) throw new HttpProblem(422, "invalid_audio_data", "data must be canonical base64");
    if (audio.byteLength > MAX_LOCAL_FILE_BYTES) throw new HttpProblem(413, "audio_too_large", "Decoded audio exceeds 5 MiB");

    let config;
    try {
      config = await this.options.managerClient.pullSpeechRuntimeConfig(caller);
    } catch (error) {
      if (error instanceof ManagerAuthorizationError) {
        throw new HttpProblem(error.status, error.status === 401 ? "unauthenticated" : "forbidden", error.message);
      }
      if (error instanceof ManagerUnavailableError) {
        throw new HttpProblem(503, "manager_unavailable", "Manager speech runtime config is unavailable");
      }
      throw error;
    }

    let endpoint: string;
    try {
      const base = new URL(config.base_url);
      if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("unsupported relay protocol");
      endpoint = new URL("audio/transcriptions", `${base.toString().replace(/\/+$/u, "")}/`).toString();
    } catch {
      throw new HttpProblem(503, "manager_unavailable", "Manager returned an invalid speech relay URL");
    }

    const form = new FormData();
    form.set("model", config.model);
    form.set("file", new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
    let upstream: Response;
    try {
      upstream = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { Accept: "application/json", Authorization: `Bearer ${config.api_key}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new HttpProblem(502, "speech_upstream_unavailable", "Speech transcription service is unavailable");
    }
    let textBody: string;
    try {
      textBody = await upstream.text();
    } catch {
      throw new HttpProblem(502, "speech_upstream_invalid", "Speech transcription response could not be read");
    }
    if (Buffer.byteLength(textBody, "utf8") > MAX_AUDIO_RESPONSE_BYTES) {
      throw new HttpProblem(502, "speech_upstream_invalid", "Speech transcription response is too large");
    }
    let payload: unknown;
    try { payload = JSON.parse(textBody); } catch { payload = undefined; }
    if (!upstream.ok) throw new HttpProblem(502, "speech_upstream_error", "Speech transcription failed");
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof (payload as Record<string, unknown>).text !== "string") {
      throw new HttpProblem(502, "speech_upstream_invalid", "Speech transcription response is invalid");
    }
    const result = payload as Record<string, unknown>;
    const duration = typeof result.duration === "number" && Number.isFinite(result.duration) && result.duration >= 0
      ? result.duration
      : undefined;
    response.setHeader("Cache-Control", "no-store");
    this.writeJson(response, 200, { data: { text: result.text, ...(duration === undefined ? {} : { duration }) } });
  }

  private async uploadLocalFile(request: IncomingMessage, response: ServerResponse, route: { conversationId: string; kind?: LocalFileKind }, caller: AuthenticatedCaller): Promise<void> {
    this.requireOwnedConversation(route.conversationId, caller);
    const body = await this.readJson(request, MAX_UPLOAD_JSON_BYTES);
    const filename = this.stringField(body.filename, "filename", MAX_LOCAL_FILE_NAME);
    if (filename.includes("/") || filename.includes("\\") || /[\x00-\x1f\x7f]/u.test(filename)) throw new HttpProblem(422, "invalid_filename", "filename must be a safe basename");
    const mimeType = body.mime_type ?? body.mimeType;
    if (typeof mimeType !== "string" || !ALLOWED_FILE_MIMES.has(mimeType)) throw new HttpProblem(422, "invalid_mime_type", "Unsupported MIME type");
    const encoded = this.stringField(body.data, "data", Math.ceil(MAX_LOCAL_FILE_BYTES / 3) * 4);
    const data = decodeBase64(encoded);
    if (!data) throw new HttpProblem(422, "invalid_file_data", "data must be canonical base64");
    if (data.byteLength > MAX_LOCAL_FILE_BYTES) throw new HttpProblem(413, "file_too_large", "Decoded file exceeds 5 MiB");
    if (mimeType.startsWith("image/") && (!IMAGE_MIMES.has(mimeType) || !hasImageSignature(mimeType, data))) throw new HttpProblem(422, "invalid_image_content", "Image MIME type does not match its content");
    try {
      const record = this.options.store.createLocalFile({ conversationId: route.conversationId, tenantId: caller.tenantId!, memberId: caller.userId ?? caller.callerId, kind: route.kind ?? "attachment", filename, mimeType, data });
      this.writeJson(response, 201, { data: record });
    } catch (error) {
      if (error instanceof Error && error.message.includes("maximum size")) throw new HttpProblem(413, "file_too_large", error.message);
      if (error instanceof Error && (error.message.includes("Local file count limit") || error.message.includes("Local file storage limit"))) throw new HttpProblem(413, "local_file_storage_limit", error.message);
      throw error;
    }
  }

  private downloadLocalFile(response: ServerResponse, route: { conversationId: string; kind?: LocalFileKind; fileId?: string }, caller: AuthenticatedCaller): void {
    if (!route.fileId) throw new HttpProblem(404, "file_not_found", "File not found");
    const loaded = this.options.store.readOwnedLocalFile(route.fileId, route.conversationId, caller.tenantId!, caller.userId ?? caller.callerId);
    if (!loaded || loaded.record.kind !== route.kind) throw new HttpProblem(404, "file_not_found", "File not found");
    this.writeBytes(response, 200, loaded.data, loaded.record.mime_type, loaded.record.filename);
  }

  private deleteLocalFile(response: ServerResponse, route: { conversationId: string; kind?: LocalFileKind; fileId?: string }, caller: AuthenticatedCaller): void {
    const existing = route.fileId ? this.options.store.getOwnedLocalFile(route.fileId, route.conversationId, caller.tenantId!, caller.userId ?? caller.callerId) : undefined;
    if (!route.fileId || !existing || existing.kind !== route.kind || !this.options.store.deleteOwnedLocalFile(route.fileId, route.conversationId, caller.tenantId!, caller.userId ?? caller.callerId)) throw new HttpProblem(404, "file_not_found", "File not found");
    this.writeJson(response, 200, { data: { deleted: true, id: route.fileId } });
  }


  private async readJson(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
    const fastifyBody = (request as BufferedRequest)[FASTIFY_BODY];
    if (fastifyBody !== undefined) {
      let serialized: string;
      try { serialized = JSON.stringify(fastifyBody); } catch { throw new HttpProblem(400, "invalid_json", "Request body must be a JSON object"); }
      if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new HttpProblem(413, "request_too_large", "Request body is too large");
      if (!fastifyBody || typeof fastifyBody !== "object" || Array.isArray(fastifyBody)) throw new HttpProblem(400, "invalid_json", "Request body must be a JSON object");
      return fastifyBody as Record<string, unknown>;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new HttpProblem(413, "request_too_large", "Request body is too large");
      chunks.push(buffer);
    }
    if (chunks.length === 0) return {};
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
      return value as Record<string, unknown>;
    } catch {
      throw new HttpProblem(400, "invalid_json", "Request body must be a JSON object");
    }
  }

  private validateInlineImages(value: unknown): ImageContent[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_PROMPT_IMAGES) throw new HttpProblem(422, "invalid_images", "images must contain at most 8 image objects");
    return value.map((image) => {
      if (!image || typeof image !== "object") throw new HttpProblem(422, "invalid_images", "Invalid image object");
      const candidate = image as Record<string, unknown>;
      if (candidate.type !== "image" || typeof candidate.data !== "string" || typeof candidate.mimeType !== "string" || !IMAGE_MIMES.has(candidate.mimeType)) throw new HttpProblem(422, "invalid_images", "Unsupported image attachment");
      const bytes = decodeBase64(candidate.data);
      if (!bytes) throw new HttpProblem(422, "invalid_images", "Image data must be canonical base64");
      if (bytes.byteLength > MAX_LOCAL_FILE_BYTES) throw new HttpProblem(413, "image_too_large", "Decoded image exceeds 5 MiB");
      if (!hasImageSignature(candidate.mimeType, bytes)) throw new HttpProblem(422, "invalid_image_content", "Image MIME type does not match its content");
      return { type: "image", data: bytes.toString("base64"), mimeType: candidate.mimeType } as ImageContent;
    });
  }

  private header(request: IncomingMessage, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }

  private writeReceipt(response: ServerResponse, conversationId: string, key: string, state: string): void {
    this.writeJson(response, 202, { data: { conversation_id: conversationId, accepted: true, state, idempotency_key: key } });
  }

  private writeJson(response: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
    if (response.writableEnded) return;
    const payload = JSON.stringify(body);
    response.writeHead(status, { "Content-Length": Buffer.byteLength(payload), "Content-Type": contentType });
    response.end(payload);
  }

  private writeHtml(response: ServerResponse, html: string): void {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  }

  private writeMetrics(response: ServerResponse): void {
    const body = [
      "# TYPE aiteam_agent_http_requests_total counter",
      `aiteam_agent_http_requests_total ${this.requests}`,
      "# TYPE aiteam_agent_http_errors_total counter",
      `aiteam_agent_http_errors_total ${this.errors}`,
      "",
    ].join("\n");
    this.writeText(response, 200, body, "text/plain; version=0.0.4; charset=utf-8");
  }

  private writeText(response: ServerResponse, status: number, body: string, contentType: string): void {
    if (response.writableEnded) return;
    response.writeHead(status, { "Content-Length": Buffer.byteLength(body), "Content-Type": contentType });
    response.end(body);
  }

  private writeBytes(response: ServerResponse, status: number, body: Buffer, contentType: string, filename: string): void {
    if (response.writableEnded) return;
    response.writeHead(status, { "Content-Length": body.byteLength, "Content-Type": contentType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` });
    response.end(body);
  }

  private serveSpa(pathname: string, response: ServerResponse): boolean {
    const root = this.options.spaRoot;
    if (!root || pathname.startsWith("/api/") || pathname === "/api") return false;
    const candidate = pathname === "/" ? "index.html" : pathname.slice(1);
    const requested = resolve(root, candidate);
    const rootResolved = resolve(root);
    const rel = relative(rootResolved, requested);
    let file = requested;
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    try { if (!statSync(file).isFile()) file = join(rootResolved, "index.html"); } catch { file = join(rootResolved, "index.html"); }
    try {
      const content = readFileSync(file);
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" }[extname(file)] ?? "application/octet-stream";
      response.writeHead(200, { "Content-Type": `${type}; charset=utf-8` }); response.end(content); return true;
    } catch { return false; }
  }

  private writeError(response: ServerResponse, error: unknown, requestId: string): void {
    if (response.writableEnded) return;
    let problem: { status: number; code: string; detail: string; errors?: unknown };
    if (error instanceof HttpProblem) problem = { status: error.status, code: error.code, detail: error.message, errors: error.errors };
    else if (error instanceof IdempotencyConflictError) problem = { status: 409, code: "idempotency_conflict", detail: error.message };
    else if (error instanceof IdempotencyUnknownError) problem = { status: 409, code: "idempotency_unknown", detail: error.message };
    else if (error instanceof ConversationBusyError) problem = { status: 409, code: "conversation_busy", detail: error.message };
    else if (error instanceof EventCursorStaleError) problem = { status: 409, code: "stale_cursor", detail: error.message };
    else if (error instanceof InvalidEventCursorError || error instanceof InvalidReadCursorError) problem = { status: 422, code: "invalid_cursor", detail: error.message };
    else if (error instanceof GroupCreationError) problem = { status: error.status, code: error.code, detail: error.message };
    else if (error instanceof GroupConfigurationError) problem = { status: error.status, code: error.code, detail: error.message };
    else if (error instanceof ConversationReadError) problem = { status: error.status, code: error.code, detail: error.message };
    else if (error instanceof SessionAuthorizationError) problem = { status: 403, code: "employee_not_authorized", detail: error.message };
    else if (error instanceof ManagerUnavailableError) problem = { status: 503, code: "manager_unavailable", detail: error.message };
    else problem = { status: 500, code: "internal_error", detail: "Internal server error" };
    this.writeJson(response, problem.status, { type: "about:blank", title: problem.code, status: problem.status, code: problem.code, detail: problem.detail, instance: requestId, request_id: requestId, ...(problem.errors ? { errors: problem.errors } : {}) }, "application/problem+json; charset=utf-8");
  }
}

function projectOrgTree(value: unknown, visibleEmployees: ReadonlySet<string>): Record<string, unknown> {
  const root = projectOrgNode(value, visibleEmployees, true);
  return root ?? { id: "root", name: "企业", type: "department", role_title: null, children: [] };
}

function projectOrgNode(value: unknown, visibleEmployees: ReadonlySet<string>, root = false): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string" || typeof source.name !== "string" || typeof source.type !== "string") return undefined;
  if (source.type === "employee" && !visibleEmployees.has(source.id)) return undefined;
  if (source.type !== "employee" && source.type !== "department") return undefined;
  const children = Array.isArray(source.children)
    ? source.children.map((child) => projectOrgNode(child, visibleEmployees)).filter((child): child is Record<string, unknown> => child !== undefined)
    : [];
  if (!root && source.type === "department" && children.length === 0) return undefined;
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    role_title: source.type === "employee" ? employeeDisplay(source).role_title : null,
    ...(typeof source.parent_id === "string" || source.parent_id === null ? { parent_id: source.parent_id } : {}),
    ...(typeof source.status === "string" || source.status === null ? { status: source.status } : {}),
    ...(typeof source.avatar_url === "string" || source.avatar_url === null ? { avatar_url: source.avatar_url } : {}),
    children,
  };
}

function parsePermissionMode(value: unknown): ConversationPermissionMode {
  if (value === undefined) return "read-only";
  if (value === "read-only" || value === "workspace-write" || value === "full-access") return value;
  throw new HttpProblem(422, "invalid_permission_mode", "permission_mode must be read-only, workspace-write, or full-access");
}

function parseThinkingLevel(value: unknown): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  if (value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") return value;
  throw new HttpProblem(422, "invalid_thinking_level", "thinking_level must be off, minimal, low, medium, high, xhigh, or max");
}

function decodeBase64(value: string): Buffer | undefined {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

function redocHtml(url: string): string {
  return `<!doctype html><title>AI Team Agent API</title><redoc spec-url=${JSON.stringify(url)}></redoc><script src="/redoc/redoc.standalone.js"></script>`;
}
