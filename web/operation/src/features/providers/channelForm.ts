import { THINKING_LEVELS, type ThinkingLevel } from "../catalog/register/thinking";
import type { GatewayChannel, GatewayChannelInput, ModelCapabilitiesInput, PlatformModel, ThinkingMode } from "./types";

export const MASK = "********";

/**
 * One model the channel can offer. `upstream` is the name the upstream knows;
 * `name` is the model id our platform exposes (a rename becomes a gateway model_mapping entry).
 */
export interface ModelRow {
  upstream: string;
  name: string;
  selected: boolean;
}

/** Editable state of one gateway channel; JSON fields stay as text until submit. */
export interface ChannelForm {
  name: string;
  channelType: string;
  baseUrl: string;
  key: string;
  rows: ModelRow[];
  /** Mapping entries that do not belong to a listed model; kept untouched on save. */
  extraMapping: Record<string, string>;
  headerOverride: string;
  paramOverride: string;
  group: string;
  priority: number;
  weight: number;
  testModel: string;
}

export type FormResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function emptyChannelForm(): ChannelForm {
  return {
    name: "", channelType: "1", baseUrl: "", key: "", rows: [], extraMapping: {}, headerOverride: "", paramOverride: "",
    group: "default", priority: 0, weight: 0, testModel: "",
  };
}

function jsonText(value: Record<string, unknown>): string {
  return Object.keys(value).length ? JSON.stringify(value, null, 2) : "";
}

export function channelToForm(channel: GatewayChannel): ChannelForm {
  const listed = new Set(channel.models);
  return {
    name: channel.name,
    channelType: String(channel.channel_type),
    baseUrl: channel.base_url,
    key: "",
    rows: channel.models.map((name) => ({ upstream: channel.model_mapping[name] || name, name, selected: true })),
    extraMapping: Object.fromEntries(Object.entries(channel.model_mapping).filter(([name]) => !listed.has(name))),
    headerOverride: jsonText(channel.header_override),
    paramOverride: jsonText(channel.param_override),
    group: channel.group,
    priority: channel.priority,
    weight: channel.weight,
    testModel: channel.test_model ?? "",
  };
}

/** Model names separated by newlines or commas, trimmed and de-duplicated in order. */
export function parseModelList(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

/** Append upstream models not seen yet as unchecked rows; existing rows keep their choice. */
export function mergeModelRows(rows: ModelRow[], upstream: string[]): ModelRow[] {
  const known = new Set(rows.map((row) => row.upstream));
  const added = [...new Set(upstream)].filter((name) => !known.has(name)).map((name) => ({ upstream: name, name, selected: false }));
  return [...rows, ...added];
}

/** Manually typed model names: check existing rows, append the rest as checked rows. */
export function addModelRows(rows: ModelRow[], text: string): ModelRow[] {
  const names = parseModelList(text);
  const checked = rows.map((row) => (names.includes(row.upstream) ? { ...row, selected: true } : row));
  const known = new Set(rows.map((row) => row.upstream));
  return [...checked, ...names.filter((name) => !known.has(name)).map((name) => ({ upstream: name, name, selected: true }))];
}

/** Step 1 check before fetching models or moving on. */
export function connectionError(form: ChannelForm, { isNew }: { isNew: boolean }): string | null {
  if (!form.name.trim()) return "请填写渠道名称";
  if (isNew && !form.key.trim()) return "新建渠道需要填写 API Key";
  return null;
}

function selectedModels(rows: ModelRow[]): FormResult<{ models: string[]; mapping: Record<string, string> }> {
  const models: string[] = [];
  const mapping: Record<string, string> = {};
  for (const row of rows.filter((item) => item.selected)) {
    const name = row.name.trim();
    if (!name) return { ok: false, error: `模型「${row.upstream}」的平台模型名不能为空` };
    if (models.includes(name)) return { ok: false, error: `平台模型名「${name}」重复` };
    models.push(name);
    if (name !== row.upstream) mapping[name] = row.upstream;
  }
  if (!models.length) return { ok: false, error: "至少选择一个模型" };
  return { ok: true, value: { models, mapping } };
}

function parseObject(text: string, label: string): FormResult<Record<string, unknown>> {
  if (!text.trim()) return { ok: true, value: {} };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, error: `${label}不是有效的 JSON` }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: `${label}必须是 JSON 对象` };
  return { ok: true, value: value as Record<string, unknown> };
}

function parseStringMap(text: string, label: string): FormResult<Record<string, string>> {
  const parsed = parseObject(text, label);
  if (!parsed.ok) return parsed;
  if (Object.values(parsed.value).some((item) => typeof item !== "string")) return { ok: false, error: `${label}的值必须是字符串` };
  return { ok: true, value: parsed.value as Record<string, string> };
}

export function formToChannelInput(form: ChannelForm, { isNew }: { isNew: boolean }): FormResult<GatewayChannelInput> {
  const connection = connectionError(form, { isNew });
  if (connection) return { ok: false, error: connection };
  const chosen = selectedModels(form.rows);
  if (!chosen.ok) return chosen;
  const headers = parseStringMap(form.headerOverride, "自定义请求头");
  if (!headers.ok) return headers;
  const params = parseObject(form.paramOverride, "参数覆盖");
  if (!params.ok) return params;
  const input: GatewayChannelInput = {
    name: form.name.trim(),
    channel_type: Number(form.channelType),
    base_url: form.baseUrl.trim(),
    models: chosen.value.models,
    model_mapping: { ...form.extraMapping, ...chosen.value.mapping },
    header_override: headers.value,
    param_override: params.value,
    group: form.group.trim() || "default",
    priority: form.priority,
    weight: form.weight,
    test_model: form.testModel.trim() || null,
  };
  if (form.key.trim()) input.key = form.key.trim();
  return { ok: true, value: input };
}

// ---- model capabilities ------------------------------------------------

export interface CapabilitiesForm {
  displayName: string;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  thinkingMode: ThinkingMode;
  levels: ThinkingLevel[];
  levelMap: Partial<Record<ThinkingLevel, string>>;
  image: boolean;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function capabilitiesToForm(model: PlatformModel): CapabilitiesForm {
  const caps = model.capabilities ?? {};
  const levels = Array.isArray(caps.thinking_levels)
    ? THINKING_LEVELS.filter((level) => (caps.thinking_levels as unknown[]).includes(level))
    : [];
  const rawMap = caps.thinking_level_map && typeof caps.thinking_level_map === "object" ? caps.thinking_level_map as Record<string, unknown> : {};
  const levelMap: Partial<Record<ThinkingLevel, string>> = {};
  for (const level of THINKING_LEVELS) {
    if (typeof rawMap[level] === "string") levelMap[level] = rawMap[level] as string;
  }
  const mode = caps.thinking_mode;
  const reasoning = caps.reasoning === true;
  const input = Array.isArray(caps.input) ? caps.input : Array.isArray(caps.input_modalities) ? caps.input_modalities : [];
  return {
    displayName: model.display_name,
    contextWindow: positiveInt(caps.context_window),
    maxTokens: positiveInt(caps.max_tokens),
    reasoning,
    thinkingMode: mode === "toggle" || mode === "effort" || mode === "budget" ? mode : reasoning ? "effort" : "none",
    levels: levels.length ? levels : ["off"],
    levelMap,
    image: input.includes("image"),
  };
}

export function formToCapabilitiesInput(form: CapabilitiesForm): FormResult<ModelCapabilitiesInput> {
  if (form.contextWindow !== null && form.contextWindow < 1024) return { ok: false, error: "上下文窗口至少 1024" };
  if (form.contextWindow && form.maxTokens && form.maxTokens > form.contextWindow) return { ok: false, error: "最大输出不能超过上下文窗口" };
  const levels = form.reasoning ? THINKING_LEVELS.filter((level) => level === "off" || form.levels.includes(level)) : ["off" as const];
  if (form.reasoning && levels.length < 2) return { ok: false, error: "支持思考的模型至少开放一个思考档位" };
  if (form.reasoning && form.thinkingMode === "none") return { ok: false, error: "请选择思考方式" };
  const levelMap: Record<string, string | null> = {};
  for (const level of levels) {
    const mapped = form.levelMap[level]?.trim();
    if (mapped) levelMap[level] = mapped;
  }
  return {
    ok: true,
    value: {
      display_name: form.displayName.trim(),
      context_window: form.contextWindow,
      max_tokens: form.maxTokens,
      reasoning: form.reasoning,
      thinking_mode: form.reasoning ? form.thinkingMode : "none",
      thinking_levels: levels,
      thinking_level_map: levelMap,
      input: form.image ? ["text", "image"] : ["text"],
    },
  };
}

export function channelStatusLabel(status: GatewayChannel["status"]): { label: string; variant: "success" | "neutral" | "warning" } {
  if (status === "enabled") return { label: "已启用", variant: "success" };
  if (status === "manually_disabled") return { label: "已停用", variant: "neutral" };
  if (status === "auto_disabled") return { label: "自动停用", variant: "warning" };
  return { label: "未知状态", variant: "neutral" };
}

export function formatTokens(value: unknown): string {
  const number = positiveInt(value);
  if (!number) return "—";
  if (number >= 1_000_000 && number % 1_000_000 === 0) return `${number / 1_000_000}M`;
  if (number >= 1000) return `${Math.round(number / 1000)}K`;
  return String(number);
}
