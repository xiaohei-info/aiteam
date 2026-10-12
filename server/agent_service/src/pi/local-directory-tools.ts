import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { LocalDirectoryError } from "../storage/local-directories.js";
import type { DirectoryExecution, LocalDirectoryService, LocalDirectoryTool } from "../services/local-directories.js";

const LocalDirSearchParams = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 512,
    description: "关键词查询（支持中文与空格分隔的多关键词）。禁止传入路径、员工 ID 或租户 ID。",
  }),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 15,
    default: 10,
    description: "返回结果上限（1–15）。",
  })),
}, { additionalProperties: false });

const LocalDirReadParams = Type.Object({
  citation_id: Type.String({
    minLength: 1,
    maxLength: 160,
    pattern: "^localdir:[A-Za-z0-9-]+$",
    description: "当前执行轮次由 local_dir_search 返回的引用句柄。",
  }),
  offset: Type.Optional(Type.Integer({
    minimum: 0,
    default: 0,
    description: "Unicode 码点偏移量。",
  })),
}, { additionalProperties: false });

const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: "未获得该本地资料目录或引用的访问授权。",
  authorization_unavailable: "本地目录授权通道当前不可用，请检查桌面应用权限状态。",
  citation_expired: "引用已过期或不属于当前执行轮次，请重新调用 local_dir_search。",
  source_changed: "源文件内容已发生变化，请重新调用 local_dir_search 获取最新引用。",
  file_unavailable: "目标文件不存在或当前不可读取。",
  unsupported_format: "文件格式暂不支持正文检索。",
  unsupported_file: "目标对象不是受支持的普通文件。",
  budget_exhausted: "已达到本地检索或单文件读取预算上限。",
  parse_failed: "文件编码或正文解析失败。",
  invalid_query: "搜索参数无效，请提供非空关键词且不附加额外字段。",
  invalid_offset: "读取偏移量无效。",
  cancelled: "本地目录检索任务已取消。",
};

function formatToolError(error: unknown): AgentToolResult<unknown> {
  const code = error instanceof LocalDirectoryError && ERROR_MESSAGES[error.code]
    ? error.code
    : "authorization_unavailable";
  const payload = {
    source: "local_directory",
    error: code,
    message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.authorization_unavailable,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}

export function createLocalDirectoryTools(
  service: LocalDirectoryService,
  allowedTools: readonly LocalDirectoryTool[],
  resolveExecution: () => DirectoryExecution,
): ToolDefinition[] {
  const allowed = new Set(allowedTools);
  const definitions: ToolDefinition[] = [];
  if (allowed.has("local_dir_search")) {
    definitions.push({
      name: "local_dir_search",
      label: "检索授权本地资料目录",
      description: "在当前成员已授权且绑定给本员工的本地资料目录中按关键词检索正文片段，返回可核验的 citation_id。",
      parameters: LocalDirSearchParams as never,
      execute: async (_toolCallId, params, signal) => {
        if (!Value.Check(LocalDirSearchParams, params)) {
          return formatToolError(new LocalDirectoryError("invalid_query"));
        }
        try {
          const result = await service.search(resolveExecution(), params.query, params.limit ?? 10, signal);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
          };
        } catch (error) {
          return formatToolError(error);
        }
      },
    });
  }
  if (allowed.has("local_dir_read")) {
    definitions.push({
      name: "local_dir_read",
      label: "读取本地资料引用片段",
      description: "按 citation_id 与 Unicode 码点 offset 读取已授权本地资料的正文片段。",
      parameters: LocalDirReadParams as never,
      execute: async (_toolCallId, params, signal) => {
        if (!Value.Check(LocalDirReadParams, params)) {
          return formatToolError(new LocalDirectoryError("invalid_offset"));
        }
        try {
          const result = await service.read(resolveExecution(), params.citation_id, params.offset ?? 0, signal);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
          };
        } catch (error) {
          return formatToolError(error);
        }
      },
    });
  }
  return definitions;
}
