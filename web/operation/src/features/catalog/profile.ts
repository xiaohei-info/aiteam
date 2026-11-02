/**
 * 人才市场展示字段（议题 7）——对齐后端 shared/contracts/expert_profile.py。
 *
 * 字符串字段空串表示未填写；required_permissions / pricing 为 null 表示未声明，
 * PATCH 时显式 null 会清除。只适用于专家模板，行业方案不携带这些字段。
 */

export const OUTPUT_TYPES = ["document", "spreadsheet", "code", "presentation", "system_operation"] as const;
export type OutputType = typeof OUTPUT_TYPES[number];
export const OUTPUT_TYPE_LABELS: Record<OutputType, string> = {
  document: "文档",
  spreadsheet: "表格",
  code: "代码",
  presentation: "演示",
  system_operation: "操作外部系统",
};

export const PRICING_MODES = ["per_call", "per_token", "subscription"] as const;
export type PricingMode = typeof PRICING_MODES[number];
export const PRICING_MODE_LABELS: Record<PricingMode, string> = {
  per_call: "按次",
  per_token: "按 Token",
  subscription: "套餐",
};

/** 套餐周期（对齐 shared/contracts/expert_profile.py BillingPeriod）；仅套餐必填。 */
export const BILLING_PERIODS = ["month", "year"] as const;
export type BillingPeriod = typeof BILLING_PERIODS[number];
export const BILLING_PERIOD_LABELS: Record<BillingPeriod, string> = { month: "按月", year: "按年" };
const BILLING_PERIOD_UNITS: Record<BillingPeriod, string> = { month: "月", year: "年" };

/** 参考单价输入框的单位提示，随计价方式变化。 */
export const UNIT_PRICE_HINTS: Record<PricingMode, string> = {
  per_call: "每次调用的价格（USD），例如 0.05",
  per_token: "每百万 Token 的价格（USD），例如 0.3",
  subscription: "每个套餐周期的价格（USD），例如 99",
};

/** 摘要展示：按次 · 0.05 USD/次、按 Token · 0.3 USD/百万 Token、套餐 · 99 USD/月。 */
export function formatPricingSummary(pricing: TemplatePricing): string {
  const unit = pricing.mode === "per_call" ? "/次"
    : pricing.mode === "per_token" ? "/百万 Token"
      : pricing.billing_period ? `/${BILLING_PERIOD_UNITS[pricing.billing_period]}` : "";
  return `${PRICING_MODE_LABELS[pricing.mode]} · ${pricing.unit_price} ${pricing.currency}${unit}`;
}

/** 与后端字段上限保持一致，用于提示文案与提交前校验；服务端仍是最终校验。 */
export const PROFILE_LIMITS = {
  tagline: 40,
  useCases: 6,
  useCaseLength: 30,
  limitations: 3,
  limitationLength: 100,
  examplePrompts: 3,
  examplePromptLength: 200,
  sampleOutputs: 6,
  sampleOutputTitleLength: 60,
  connectors: 10,
  connectorLength: 64,
  recommendedKnowledge: 10,
  recommendedKnowledgeLength: 30,
  memoryPolicySummary: 200,
  publisher: 60,
} as const;

export interface SampleOutput {
  title: string;
  output_type: OutputType;
  /** 空串表示无预览。 */
  preview_url: string;
}

export interface RequiredPermissions {
  full_access: boolean;
  local_directories: boolean;
}

export interface TemplatePricing {
  mode: PricingMode;
  /** 十进制字符串，例如 "0.05"。 */
  unit_price: string;
  currency: "USD";
  /** 套餐周期；subscription 必填，按次 / 按 Token 不带。 */
  billing_period?: BillingPeriod;
}

export interface ExpertTemplateProfile {
  tagline: string;
  use_cases: string[];
  limitations: string[];
  example_prompts: string[];
  sample_outputs: SampleOutput[];
  output_types: OutputType[];
  required_connectors: string[];
  optional_connectors: string[];
  recommended_knowledge: string[];
  required_permissions: RequiredPermissions | null;
  pricing: TemplatePricing | null;
  memory_policy_summary: string;
  publisher: string;
  changelog_url: string;
}

/** 旧模板没有这些字段时按空值补齐。 */
export function profileFromItem(item: Partial<ExpertTemplateProfile>): ExpertTemplateProfile {
  return {
    tagline: item.tagline ?? "",
    use_cases: item.use_cases ?? [],
    limitations: item.limitations ?? [],
    example_prompts: item.example_prompts ?? [],
    sample_outputs: item.sample_outputs ?? [],
    output_types: item.output_types ?? [],
    required_connectors: item.required_connectors ?? [],
    optional_connectors: item.optional_connectors ?? [],
    recommended_knowledge: item.recommended_knowledge ?? [],
    required_permissions: item.required_permissions ?? null,
    pricing: item.pricing ?? null,
    memory_policy_summary: item.memory_policy_summary ?? "",
    publisher: item.publisher ?? "",
    changelog_url: item.changelog_url ?? "",
  };
}

/** 注册 / PATCH 请求体中的展示字段：去掉首尾空白和空行，未勾选的权限按「未声明」提交。 */
export function profilePayload(profile: ExpertTemplateProfile): ExpertTemplateProfile {
  const list = (values: string[]) => values.map((value) => value.trim()).filter(Boolean);
  const permissions = profile.required_permissions;
  return {
    tagline: profile.tagline.trim(),
    use_cases: list(profile.use_cases),
    limitations: list(profile.limitations),
    example_prompts: list(profile.example_prompts),
    sample_outputs: profile.sample_outputs
      .map((output) => ({ ...output, title: output.title.trim(), preview_url: output.preview_url.trim() }))
      // 只丢掉整行空白；有链接没标题的行留给校验提示，不能悄悄丢掉。
      .filter((output) => output.title || output.preview_url),
    output_types: profile.output_types,
    required_connectors: list(profile.required_connectors),
    optional_connectors: list(profile.optional_connectors),
    recommended_knowledge: list(profile.recommended_knowledge),
    // null 为未声明，两项都为 false 为明确声明「无需额外权限」，两者含义不同。
    required_permissions: permissions,
    pricing: profile.pricing ? pricingPayload(profile.pricing) : null,
    memory_policy_summary: profile.memory_policy_summary.trim(),
    publisher: profile.publisher.trim(),
    changelog_url: profile.changelog_url.trim(),
  };
}

/** 注册请求只带填写过的展示字段，未填写的由服务端按默认值落库。 */
export function filledProfileFields(profile: ExpertTemplateProfile): Partial<ExpertTemplateProfile> {
  return Object.fromEntries(
    Object.entries(profile).filter(([, value]) => value !== null && value !== "" && !(Array.isArray(value) && value.length === 0)),
  ) as Partial<ExpertTemplateProfile>;
}

/** billing_period 单独成键，让周期提示落在周期选择框上，和单价提示互不覆盖。 */
export type ProfileErrors = Partial<Record<keyof ExpertTemplateProfile | "billing_period", string>>;

/** 按 Unicode 码点计长，与服务端 Python len() 一致。 */
function textLength(value: string): number {
  return [...value].length;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.host);
  } catch {
    return false;
  }
}

function listError(values: string[], maxItems: number, maxLength: number, name: string): string | undefined {
  if (values.length > maxItems) return `${name}最多 ${maxItems} 条`;
  if (values.some((value) => textLength(value) > maxLength)) return `${name}每条不超过 ${maxLength} 字`;
  return undefined;
}

function sampleOutputsError(outputs: SampleOutput[]): string | undefined {
  const limits = PROFILE_LIMITS;
  if (outputs.length > limits.sampleOutputs) return `示例产出最多 ${limits.sampleOutputs} 个`;
  if (outputs.some((output) => textLength(output.title) > limits.sampleOutputTitleLength)) {
    return `示例产出标题不超过 ${limits.sampleOutputTitleLength} 字`;
  }
  if (outputs.some((output) => !output.title)) return "填了预览链接的示例产出也需要填写标题";
  if (outputs.some((output) => output.preview_url && !isHttpUrl(output.preview_url))) return "示例产出预览链接需为 http/https 地址";
  return undefined;
}

/** 只有套餐带周期；切换到按次 / 按 Token 时丢掉之前选过的周期，避免服务端 422。 */
function pricingPayload(pricing: TemplatePricing): TemplatePricing {
  const { billing_period: period, ...rest } = pricing;
  const base = { ...rest, unit_price: pricing.unit_price.trim() };
  return pricing.mode === "subscription" && period ? { ...base, billing_period: period } : base;
}

/** 对 profilePayload 的结果做提交前校验，约束与 shared/contracts/expert_profile.py 一致。 */
export function validateProfile(payload: ExpertTemplateProfile): ProfileErrors {
  const errors: ProfileErrors = {};
  const limits = PROFILE_LIMITS;
  if (textLength(payload.tagline) > limits.tagline) errors.tagline = `一句话定位不超过 ${limits.tagline} 字`;
  const listChecks: Array<[keyof ExpertTemplateProfile, string[], number, number, string]> = [
    ["use_cases", payload.use_cases, limits.useCases, limits.useCaseLength, "适用场景"],
    ["limitations", payload.limitations, limits.limitations, limits.limitationLength, "不适用场景"],
    ["example_prompts", payload.example_prompts, limits.examplePrompts, limits.examplePromptLength, "示例问题"],
    ["required_connectors", payload.required_connectors, limits.connectors, limits.connectorLength, "必需的外部系统"],
    ["optional_connectors", payload.optional_connectors, limits.connectors, limits.connectorLength, "可选的外部系统"],
    ["recommended_knowledge", payload.recommended_knowledge, limits.recommendedKnowledge, limits.recommendedKnowledgeLength, "推荐知识"],
  ];
  for (const [key, values, maxItems, maxLength, name] of listChecks) {
    const error = listError(values, maxItems, maxLength, name);
    if (error) errors[key] = error;
  }
  const outputsError = sampleOutputsError(payload.sample_outputs);
  if (outputsError) errors.sample_outputs = outputsError;
  if (payload.pricing && !/^\d{1,12}(\.\d{1,6})?$/.test(payload.pricing.unit_price)) {
    errors.pricing = "参考单价需为非负数字，最多 6 位小数";
  }
  if (payload.pricing?.mode === "subscription" && !payload.pricing.billing_period) {
    errors.billing_period = "套餐需选择周期（按月或按年）";
  }
  if (textLength(payload.memory_policy_summary) > limits.memoryPolicySummary) {
    errors.memory_policy_summary = `记忆策略说明不超过 ${limits.memoryPolicySummary} 字`;
  }
  if (textLength(payload.publisher) > limits.publisher) errors.publisher = `发布者不超过 ${limits.publisher} 字`;
  if (payload.changelog_url && !isHttpUrl(payload.changelog_url)) {
    errors.changelog_url = "更新说明链接需为 http/https 地址";
  }
  return errors;
}
