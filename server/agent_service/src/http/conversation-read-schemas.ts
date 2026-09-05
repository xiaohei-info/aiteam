import { Type } from "typebox";

const PageQuery = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50, description: "返回条数；缺省 50，最大 100。" })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 8192, description: "上一页 next_cursor；绑定 owner、资源、筛选与排序，不是 entry_ref 或 SSE ID。" })),
};
export const HistoryQuery = Type.Object({
  ...PageQuery,
  entry_ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "从该历史条目起（含该条目）读取一页，用于搜索定位；不能与 cursor 合用。" })),
}, { additionalProperties: false, description: "不带参数保持旧响应且无 page；任何分页参数启用正序历史分页，不创建 Session。" });
export const MessageSearchQuery = Type.Object({
  ...PageQuery,
  q: Type.String({ minLength: 1, maxLength: 200, description: "去首尾空白后非空、大小写不敏感的字面子串；只匹配脱敏后的完整可见文本。" }),
  conversation_id: Type.Optional(Type.String({ minLength: 1, description: "仅搜索当前 owner 的指定会话；非 owner 或不存在返回 404。" })),
  employee_id: Type.Optional(Type.String({ minLength: 1, description: "按实际发送员工过滤，不包含投递给该员工的人类输入。" })),
}, { additionalProperties: false, description: "当前成员本机全部会话搜索；不上传、不创建 Session、不复制正文到 SQLite。" });

export const EmployeeDisplayProperties = {
  role_title: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()], { description: "Manager 配置的真实岗位（非账号权限/会话角色）；缺失为 null，不猜默认标签。", examples: ["研究分析师", null] }),
  department_ids: Type.Array(Type.String({ minLength: 1, maxLength: 256, description: "真实所属部门 ID。" }), { description: "Manager 配置的全部部门关联；未设置或投影缺失为 []，不选择虚构主部门或部门名。", examples: [["department-research", "department-sales"], []] }),
};

const Participant = Type.Object({
  ...EmployeeDisplayProperties,
  employee_id: Type.String({ description: "真实 participant 索引中的员工 ID。" }),
  display_name: Type.String({ maxLength: 256, description: "安全展示名；投影缺失时使用员工 ID。" }),
  handle: Type.Union([Type.String({ maxLength: 256 }), Type.Null()], { description: "当前本地投影的员工 handle；投影缺失为 null。" }),
  role: Type.String({ enum: ["coordinator", "participant"], description: "公开参与角色，不使用内部 member 枚举。" }),
  available: Type.Boolean({ description: "当前授权、active 生命周期、版本匹配快照可用；不是模型/网络健康保证，撤权为 false。" }),
}, { $id: "ConversationParticipant", additionalProperties: false, description: "真实会话数字员工；不包含 Session ID、文件路径或凭据。" });
const ParticipantsEnvelope = Type.Object({ data: Type.Object({
  conversation_id: Type.String({ description: "会话 ID。" }),
  participants: Type.Array(Type.Ref("ConversationParticipant"), { description: "coordinator 优先、employee ID 升序；空群返回空数组，绝不回退到授权全集。" }),
  employee_count: Type.Integer({ minimum: 0, description: "真实数字员工人数（包含撤权历史成员），不计人类用户。" }),
}, { additionalProperties: false }) }, { $id: "ConversationParticipantsEnvelope", description: "当前 owner 的只读成员列表。" });
const SearchHit = Type.Object({
  conversation_id: Type.String({ description: "消息所属会话 ID。" }),
  conversation_title: Type.Union([Type.String({ maxLength: 200 }), Type.Null()], { description: "安全会话标题；未设置为 null。" }),
  entry_ref: Type.String({ description: "稳定定位引用，用于 entries?entry_ref 和 last_read_entry_id；不是分页/SSE cursor。" }),
  id: Type.String({ description: "原 Pi entry ID；跨 participant 可能重复，客户端应使用 entry_ref 去重。" }),
  participant_employee_id: Type.Union([Type.String(), Type.Null()], { description: "条目所在 Session 的员工 ID，不等于发送者；旧无员工 Session 为 null。" }),
  timestamp: Type.String({ format: "date-time", description: "规范化 Pi 条目时间；旧无有效时间为 Unix epoch。" }),
  role: Type.String({ enum: ["user", "assistant"], description: "Pi 消息角色；employee 投递仍是 user，来源由 source 字段区分。" }),
  source_type: Type.Optional(Type.String({ enum: ["human", "employee"], description: "输入消息的实际来源类型。" })),
  source_id: Type.Optional(Type.String({ description: "来源索引记录的发送者 ID。" })),
  source_display_name: Type.Optional(Type.String({ description: "来源索引的安全展示名。" })),
  source_employee_id: Type.Optional(Type.String({ description: "实际发送员工 ID；人类输入不返回。" })),
  source_employee_display_name: Type.Optional(Type.String({ description: "实际发送员工安全展示名。" })),
  source_role: Type.Optional(Type.String({ enum: ["human", "participant", "coordinator"], description: "公开来源角色。" })),
  logical_message_id: Type.Optional(Type.String({ description: "fan-out 输入的逻辑消息 ID。" })),
  snippet: Type.String({ maxLength: 240, description: "完整文本脱敏后围绕匹配位置截取的短摘要；不会返回凭据片段或路径。" }),
}, { $id: "MessageSearchHit", additionalProperties: false, description: "一条本机可见逻辑消息的全文搜索结果；不返回 thinking/tool/internal 内容。" });
const SearchEnvelope = Type.Object({ data: Type.Array(Type.Ref("MessageSearchHit"), { description: "按历史全 tuple 倒序（最新优先）的匹配消息。" }), page: Type.Ref("Page") }, { $id: "MessageSearchEnvelope", description: "本机全文搜索结果及 filter-scoped 下一页游标。" });

export const CONVERSATION_READ_SCHEMAS = [Participant, ParticipantsEnvelope, SearchHit, SearchEnvelope];
export const CONVERSATION_READ_DOCS = {
  listConversationParticipants: { responses: { "200": { description: "真实 Session participant roster（不含本机人类用户）。", examples: { roster: { summary: "包含撤权历史成员", value: { data: { conversation_id: "conversation-1", participants: [{ employee_id: "employee-1", display_name: "研究员", handle: "researcher", role_title: "研究分析师", department_ids: ["department-research", "department-sales"], role: "coordinator", available: true }, { employee_id: "employee-2", display_name: "分析员", handle: "analyst", role_title: null, department_ids: [], role: "participant", available: false }], employee_count: 2 } } } } } } },
  searchMessages: {
    request: { q: { summary: "搜索词", value: "总结" }, employee_id: { summary: "实际发送员工", value: "employee-1" }, conversation_id: { summary: "指定会话", value: "conversation-1" }, limit: { summary: "条数", value: 50 }, cursor: { summary: "原样使用上一页 next_cursor", value: "page_v1.opaque" } },
    responses: { "200": { description: "从完整安全文本匹配，snippet 最多 240 字；cursor 与 q/会话/员工筛选绑定。", examples: { messages: { summary: "搜索命中", value: { data: [{ conversation_id: "conversation-1", conversation_title: "每日总结", entry_ref: "entry_v1_opaque", id: "pi-entry-1", participant_employee_id: "employee-1", timestamp: "2026-09-05T08:00:00.000Z", role: "assistant", source_employee_id: "employee-1", source_employee_display_name: "研究员", source_role: "coordinator", snippet: "以下是今日总结。" }], page: { next_cursor: null, has_more: false } } } } } },
  },
};
