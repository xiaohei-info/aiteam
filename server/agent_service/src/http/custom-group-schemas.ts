import { Type } from "typebox";

export const GroupOrchestration = Type.Union([
  Type.Object({ mode: Type.Literal("auto") }, { additionalProperties: false }),
  Type.Object({
    mode: Type.Literal("custom"),
    format: Type.Literal("collaboration-markdown-v1"),
    prompt: Type.String({ minLength: 1, maxLength: 16_000, description: "协作规则；员工以 @{employee_id} 引用。" }),
  }, { additionalProperties: false }),
], { $id: "GroupOrchestration", description: "会话级编排配置；自动模式只使用群简介，自定义模式使用协作提示词。" });

export const CustomGroupCreateRequest = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "客户端固定创建 ID；重复时返回 409，可读取同 ID 恢复。" })),
  title: Type.String({ minLength: 1, maxLength: 200, description: "群聊名称，去除首尾空白后必填。" }),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 4000 }), Type.Null()], { description: "群简介；自动模式必填，自定义模式不参与编排。" })),
  member_employee_ids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 32, uniqueItems: true, description: "当前用户已授权的固定群成员。" }),
  coordinator_employee_id: Type.String({ minLength: 1, maxLength: 256, description: "所选成员中的协调人。" }),
  orchestration: Type.Ref("GroupOrchestration"),
  permission_mode: Type.Optional(Type.Ref("ConversationPermissionMode")),
}, { $id: "CustomGroupCreateRequest", additionalProperties: false, description: "自选成员建群；自动或自定义编排。不能混用旧方案、kind 或客户端所有者字段。" });

const GroupDescription = Type.Union([Type.String({ minLength: 1, maxLength: 4000 }), Type.Null()], { description: "群简介；自动模式必填，自定义模式可传 null 清空。" });

export const GroupOrchestrationUpdateRequest = Type.Object({
  orchestration: Type.Ref("GroupOrchestration"),
  description: Type.Optional(GroupDescription),
}, { $id: "GroupOrchestrationUpdateRequest", additionalProperties: false, description: "整体替换自选成员群的编排；可同时调整群简介（切换到自动模式必须有非空简介）。下一轮执行生效。" });

export const GroupMembersUpdateRequest = Type.Object({
  add_employee_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32, uniqueItems: true, description: "要加入的员工；须为当前用户已授权、尚未在群内的员工。" })),
  remove_employee_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32, uniqueItems: true, description: "要移出的现有成员；不能包含协调人。" })),
  orchestration: Type.Optional(Type.Ref("GroupOrchestration", { description: "同一次变更中同步更新的编排；自定义规则引用了被移出的成员时必须一并提供。" })),
  description: Type.Optional(GroupDescription),
}, { $id: "GroupMembersUpdateRequest", additionalProperties: false, description: "原子地增减自选成员群成员；成员、简介和编排按合并后的结果统一校验。" });

export const GroupMembersUpdateEnvelope = Type.Object({
  data: Type.Object({
    conversation: Type.Ref("ConversationMetadata"),
    participants: Type.Array(Type.Ref("ConversationParticipant"), { description: "变更后的当前成员，coordinator 优先。" }),
    employee_count: Type.Integer({ minimum: 0, description: "变更后的成员人数。" }),
  }, { additionalProperties: false }),
}, { $id: "GroupMembersUpdateEnvelope", description: "成员变更后的会话元数据与最新成员列表。" });
