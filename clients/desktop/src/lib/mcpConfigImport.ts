/**
 * MCP 配置粘贴导入（设计 2026-11-18 MCP鉴权与配置导入 §3.9）。纯函数，不发请求。
 *
 * 接受：
 *   - 单条带名称：`"cr-test": { … }` 或 `{ "cr-test": { … } }`
 *   - Claude / Cursor / VS Code 格式：`{ "mcpServers": { … } }` / `{ "servers": { … } }`
 *   - 单条无名称：`{ "type": "streamableHttp", "url": "…" }`
 *   - 纯链接：`https://…`
 * 只支持 streamable HTTP 远程服务（type 为 streamableHttp / streamable-http / http，或不写 type 只给 url）；
 * sse、stdio、带 command 的条目被拒绝并说明原因。headers 里的 Authorization 或名称含 key / token 的请求头
 * 视为访问令牌：自动设 auth=bearer 与请求头名，**令牌值丢弃**，不会进入任何返回值。
 *
 * 这是 `web/shared/src/contracts/mcp-config.ts` 的同一份逻辑：桌面端不能 import web/（AGENTS.md §9），
 * 两边测试用例相同（tests/mcpConfigImport.test.ts）；Manager 的 `server/shared/mcp_config.py` 是第三份。修改任一处须同步其余两处。
 */

export interface McpConfigCandidate {
  /** 配置里的名称；纯链接或无名称时为空。 */
  name: string;
  /** 建议的标识（小写字母开头，只含小写字母、数字、- 或 _）。 */
  ref: string;
  /** 名称不合规则、ref 是改写后的建议。 */
  refAdjusted: boolean;
  url: string;
  /** 毫秒，已限制在 1000–300000；配置里 < 1000 的数按秒换算。未写则缺省。 */
  timeout_ms?: number;
  /** 配置带了令牌类请求头时为 bearer；否则不设（由探测判断）。 */
  auth?: "bearer";
  /** bearer 的请求头名；空表示 Authorization: Bearer。 */
  auth_header?: string;
  /** 配置里带了令牌值，已丢弃。 */
  droppedSecret: boolean;
  /** 无法带入的其它请求头名（值不保留）。 */
  ignoredHeaders: string[];
}

export interface McpConfigRejected {
  name: string;
  reason: string;
}

export type McpConfigParseResult =
  | { ok: true; servers: McpConfigCandidate[]; rejected: McpConfigRejected[] }
  | { ok: false; error: string };

const REF_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ACCEPTED_TYPES = new Set(["streamablehttp", "streamable-http", "streamable_http", "http"]);
const SECRET_HEADER_RE = /^authorization$|key|token|secret/i;
const MIN_TIMEOUT = 1_000;
const MAX_TIMEOUT = 300_000;
const ONLY_HTTP = "只支持 streamable HTTP 远程服务";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 名称 → 合规标识建议。 */
export function suggestMcpRef(name: string): string {
  let ref = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  if (!/^[a-z]/.test(ref)) ref = `mcp-${ref}`.replace(/-+$/, "");
  return ref.slice(0, 64).replace(/[-_]+$/, "") || "mcp";
}

function timeoutOf(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number) || number <= 0) return undefined;
  const ms = number < MIN_TIMEOUT ? number * 1000 : number; // 有的客户端以秒为单位（如 60）
  return Math.min(Math.max(Math.round(ms), MIN_TIMEOUT), MAX_TIMEOUT);
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function candidate(name: string, entry: Json): McpConfigCandidate | McpConfigRejected {
  const label = name || "（未命名）";
  const type = typeof entry.type === "string" ? entry.type.trim().toLowerCase() : typeof entry.transport === "string" ? entry.transport.trim().toLowerCase() : "";
  if (entry.command !== undefined || type === "stdio") return { name: label, reason: `本地命令（stdio）无法在平台使用：${ONLY_HTTP}` };
  if (type === "sse") return { name: label, reason: `SSE 传输不受支持：${ONLY_HTTP}` };
  if (type && !ACCEPTED_TYPES.has(type)) return { name: label, reason: `不支持的类型 ${type}：${ONLY_HTTP}` };
  const rawUrl = entry.url ?? entry.serverUrl;
  const url = httpUrl(rawUrl);
  if (!url) return { name: label, reason: rawUrl === undefined ? "缺少 url" : "url 不是有效的 http(s) 地址" };

  let auth: "bearer" | undefined;
  let authHeader: string | undefined;
  let droppedSecret = false;
  const ignoredHeaders: string[] = [];
  if (isObject(entry.headers)) {
    for (const [header, value] of Object.entries(entry.headers)) {
      if (SECRET_HEADER_RE.test(header) && auth === undefined) {
        auth = "bearer";
        authHeader = header.toLowerCase() === "authorization" ? "" : header;
        droppedSecret = droppedSecret || (typeof value === "string" && value.trim() !== "");
      } else if (SECRET_HEADER_RE.test(header)) {
        droppedSecret = droppedSecret || (typeof value === "string" && value.trim() !== "");
        ignoredHeaders.push(header);
      } else {
        ignoredHeaders.push(header);
      }
    }
  }
  const trimmed = name.trim();
  const ref = trimmed && REF_RE.test(trimmed) ? trimmed : suggestMcpRef(trimmed || new URL(url).pathname.split("/").filter(Boolean).slice(-1)[0] || new URL(url).hostname.split(".")[0] || "mcp");
  const timeout = timeoutOf(entry.timeout ?? entry.timeout_ms ?? entry.timeoutMs);
  return {
    name: trimmed, ref, refAdjusted: Boolean(trimmed) && ref !== trimmed, url,
    ...(timeout !== undefined ? { timeout_ms: timeout } : {}),
    ...(auth ? { auth, auth_header: authHeader ?? "" } : {}),
    droppedSecret, ignoredHeaders,
  };
}

function looksLikeEntry(value: Json): boolean {
  return ["url", "serverUrl", "type", "transport", "command", "headers"].some((key) => key in value);
}

function parseJson(text: string): unknown {
  const attempts = [text, `{${text}}`, `{${text.replace(/,\s*$/, "")}}`];
  for (const attempt of attempts) {
    try { return JSON.parse(attempt); } catch { /* try next */ }
  }
  return undefined;
}

export function parseMcpConfig(input: string): McpConfigParseResult {
  const text = input.trim();
  if (!text) return { ok: false, error: "请粘贴 MCP 配置或链接" };
  if (/^https?:\/\//i.test(text) && !/\s/.test(text)) {
    const result = candidate("", { url: text });
    return "reason" in result ? { ok: false, error: result.reason } : { ok: true, servers: [result], rejected: [] };
  }
  const parsed = parseJson(text);
  if (!isObject(parsed)) return { ok: false, error: "无法识别：请粘贴 JSON 配置（如 {\"mcpServers\": {…}}）或 https 链接" };

  let entries: [string, unknown][];
  const wrapper = isObject(parsed.mcpServers) ? parsed.mcpServers : isObject(parsed.servers) ? parsed.servers : null;
  if (wrapper) entries = Object.entries(wrapper);
  else if (looksLikeEntry(parsed)) entries = [["", parsed]];
  else entries = Object.entries(parsed);

  const servers: McpConfigCandidate[] = [];
  const rejected: McpConfigRejected[] = [];
  for (const [name, value] of entries) {
    if (!isObject(value)) { rejected.push({ name: name || "（未命名）", reason: "不是 MCP 配置对象" }); continue; }
    const result = candidate(name, value);
    if ("reason" in result) rejected.push(result); else servers.push(result);
  }
  if (!servers.length && !rejected.length) return { ok: false, error: "配置里没有 MCP 服务" };
  return { ok: true, servers, rejected };
}
