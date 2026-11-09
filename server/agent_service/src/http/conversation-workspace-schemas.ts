import { Type } from "typebox";
import { WORKSPACE_KEY_SOURCE } from "../workspace-layout.js";

const nullableId = (description: string) => Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()], { description });

const ConversationWorkspace = Type.Object({
  employee_id: nullableId("使用该工作目录的数字员工；旧版无员工会话为 null。"),
  role: Type.String({ enum: ["entry", "coordinator", "member"], description: "entry 为私聊入口员工，coordinator 为群协调员工，member 为其他群成员。" }),
  removed: Type.Boolean({ description: "该成员已移出群聊；目录保留历史产出，仍会返回。" }),
  workspace_key: Type.String({ minLength: 1, maxLength: 257, pattern: WORKSPACE_KEY_SOURCE, description: "受管工作目录相对 Agent 数据目录 workspaces/ 的路径，以 / 分隔：私聊和群聊都是「会话名-短 ID」一段（群聊成员共用，各行相同），换过员工的旧私聊为「会话名-短 ID/员工名」两段；旧版目录为 conversation-<24 位十六进制> 一段。各段不以 . 开头、不含路径分隔符与控制字符；不返回本机绝对路径。" }),
  has_files: Type.Boolean({ description: "目录内是否至少有一个非空文件；忽略隐藏文件、node_modules、__pycache__、venv 与符号链接。目录过大、扫描达到上限仍未确定时按 true 返回，由桌面端列文件时再确认，避免把有项目的目录判成没有文件。" }),
}, { $id: "ConversationWorkspace", additionalProperties: false, description: "一个数字员工在会话中的受管工作目录；不含文件列表与内容。" });

const ConversationWorkspaces = Type.Object({
  conversation_id: Type.String({ minLength: 1, description: "会话 ID。" }),
  kind: Type.String({ minLength: 1, description: "会话类型，例如 chat（私聊）或 group（群聊）。" }),
  title: Type.Union([Type.String({ maxLength: 200 }), Type.Null()], { description: "安全会话标题；未设置为 null。" }),
  entry_employee_id: nullableId("私聊入口员工；群聊为 null。"),
  coordinator_employee_id: nullableId("群协调员工；私聊为 null。"),
  updated_at: Type.String({ format: "date-time", description: "会话最近更新时间。" }),
  workspaces: Type.Array(Type.Ref("ConversationWorkspace"), { description: "协调员工优先、员工 ID 升序；只含真实存在于受管根目录下的目录。" }),
}, { $id: "ConversationWorkspaces", additionalProperties: false, description: "一个会话的全部受管工作目录。" });

const ConversationWorkspaceListEnvelope = Type.Object({
  data: Type.Array(Type.Ref("ConversationWorkspaces"), { description: "当前成员的会话，按更新时间倒序；没有任何受管目录的会话不返回。" }),
  page: Type.Ref("Page"),
}, { $id: "ConversationWorkspaceListEnvelope", description: "当前成员全部会话的工作目录一次性列表。" });

export const CONVERSATION_WORKSPACE_SCHEMAS = [ConversationWorkspace, ConversationWorkspaces, ConversationWorkspaceListEnvelope];

export const CONVERSATION_WORKSPACE_DOCS = {
  listConversationWorkspaces: {
    responses: {
      "200": {
        description: "桌面工作台用的目录索引；不含路径、文件名或文件内容。",
        examples: {
          group: {
            summary: "群聊成员共用一个目录，已移出成员也保留一行",
            value: {
              data: [{
                conversation_id: "group-client-1",
                kind: "group",
                title: "官网改版",
                entry_employee_id: null,
                coordinator_employee_id: "employee-1",
                updated_at: "2026-11-03T01:25:00.000Z",
                workspaces: [
                  { employee_id: "employee-1", role: "coordinator", removed: false, workspace_key: "官网改版-96acab", has_files: true },
                  { employee_id: "employee-2", role: "member", removed: true, workspace_key: "官网改版-96acab", has_files: true },
                ],
              }],
              page: { next_cursor: null, has_more: false },
            },
          },
        },
      },
    },
  },
};
