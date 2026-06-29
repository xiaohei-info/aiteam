/**
 * P1-F7 Browser 端失败诊断（最终执行 DAG §5.1 P1-F7、§8 统一诊断纪律）。
 *
 * 与服务端 diagnostics.py 同口径：失败后能定位层级，但**绝不**输出
 * secret / provider key / 会话正文 / 文件正文 / 工具 I/O 明细（DAG §8）。
 *
 * 设计：redactDiagnostics() 按敏感键名脱敏、按会话/文件/工具内容键名丢弃；
 * buildFailureDiagnostics() 只持结构化定位字段（layer/summary/url/status/problem）。
 * 纯逻辑、可被 node 直接 type-strip 运行单测，不依赖浏览器。
 */

import type { TestInfo } from "@playwright/test";

export const REDACTED = "[REDACTED]";

/** 命中即整值脱敏（小写子串匹配）。 */
export const SENSITIVE_KEY_SUBSTRINGS: readonly string[] = [
  "secret",
  "password",
  "passwd",
  "token",
  "authorization",
  "cookie",
  "session",
  "private_pem",
  "private_key",
  "privatekey",
  "api_key",
  "apikey",
  "credential",
  "provider_key",
  "signing_key",
  "access_key",
];

/** 会话/文件/工具内容键名——诊断绝不携带（DAG §8 / 闭环 C C2）。 */
export const FORBIDDEN_CONTENT_SUBSTRINGS: readonly string[] = [
  "message_text",
  "messages",
  "transcript",
  "conversation_text",
  "content",
  "prompt",
  "completion",
  "file_content",
  "file_body",
  "tool_input",
  "tool_output",
  "tool_io",
  "raw_payload",
];

/** 失败层级（对齐 diagnostics.py DiagnosticLayer）。 */
export type DiagnosticLayer =
  | "pg"
  | "auth"
  | "tenant"
  | "grants"
  | "outbox"
  | "rollup"
  | "api"
  | "browser";

export type FailureDiagnostics = {
  layer: DiagnosticLayer;
  summary: string;
  url?: string;
  status?: number;
  problem?: { status: number; problemJson: boolean; type?: unknown; title?: unknown };
  context?: Record<string, unknown>;
};

function isSensitive(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_SUBSTRINGS.some((s) => k.includes(s));
}

function isForbiddenContent(key: string): boolean {
  const k = key.toLowerCase();
  return FORBIDDEN_CONTENT_SUBSTRINGS.some((s) => k.includes(s));
}

/**
 * 递归脱敏：敏感键 -> [REDACTED]；会话/文件/工具内容键 -> 整键丢弃。
 */
export function redactDiagnostics(value: unknown, key?: string): unknown {
  if (key !== undefined && isSensitive(key)) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDiagnostics(v, key));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenContent(k)) {
        continue;
      }
      out[k] = isSensitive(k) ? REDACTED : redactDiagnostics(v, k);
    }
    return out;
  }
  return value;
}

/** 从 problem+json 响应只取定位字段（type/title/status），丢弃 detail/instance。 */
export function captureProblemJson(status: number, body: unknown): FailureDiagnostics["problem"] {
  if (body === null || typeof body !== "object") {
    return { status, problemJson: false };
  }
  const b = body as Record<string, unknown>;
  return { status, problemJson: true, type: b["type"], title: b["title"] };
}

/**
 * URL 清洗：只保留 origin + pathname，**丢弃 query 与 hash**（token/session/code 常驻其中）。
 * 解析失败（相对路径/畸形）退化为按 `?`/`#` 截断。空值原样返回。
 */
export function sanitizeUrl(url: string | undefined): string | undefined {
  if (!url) {
    return url;
  }
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/, 1)[0] ?? url;
  }
}

// `Bearer <token>`：token 值取**任意非空白串**（不限字符集），含 `Bearer ***` 等占位形态。
const BEARER_RE = /\b([Bb]earer)\s+\S+/g;
const SENSITIVE_PAIR_RE = new RegExp(
  `\\b([A-Za-z0-9_-]*(?:${SENSITIVE_KEY_SUBSTRINGS.join("|")})[A-Za-z0-9_-]*)\\s*([=:])\\s*[^\\s&#"',;]+`,
  "gi",
);

/**
 * 自由文本脱敏：summary 等可能夹带 secret 字面量。
 * 清洗 `Bearer xxx` 与敏感 `key=value` / `key: value`（含 URL query 形态）。
 */
export function redactText(text: string | undefined): string | undefined {
  if (!text) {
    return text;
  }
  return text
    .replace(BEARER_RE, "$1 " + REDACTED)
    .replace(SENSITIVE_PAIR_RE, (_m, key, sep) => `${key}${sep}${REDACTED}`);
}

/**
 * 构造结构化失败诊断：**整对象**纵深脱敏，不止 context。
 * - 敏感键名 -> [REDACTED]、会话/文件/工具内容键 -> 丢弃（redactDiagnostics）。
 * - url 只留 origin+path（清洗 query/hash 里的 token/session/code）。
 * - summary 自由文本扫敏感字面量（Bearer / key=value）。
 */
export function buildFailureDiagnostics(input: FailureDiagnostics): FailureDiagnostics {
  const deep = redactDiagnostics(input) as Record<string, unknown>;
  const out = { ...(deep as unknown as FailureDiagnostics) };
  out.summary = redactText(out.summary) ?? out.summary;
  if (out.url !== undefined) {
    out.url = sanitizeUrl(out.url);
  }
  return out;
}

/**
 * 把脱敏后的诊断作为 attachment 挂到 testInfo（仅失败用例）。
 * 不附会话/文件正文，只附结构化定位 JSON——Browser 层诊断入口（DAG §8）。
 */
export async function attachDiagnostics(
  testInfo: Pick<TestInfo, "attach">,
  diag: FailureDiagnostics,
): Promise<void> {
  const safe = buildFailureDiagnostics(diag);
  await testInfo.attach("failure-diagnostics.json", {
    body: JSON.stringify(safe, null, 2),
    contentType: "application/json",
  });
}
