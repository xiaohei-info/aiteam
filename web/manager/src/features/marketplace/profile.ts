/**
 * 人才市场卡片/详情的展示规则（议题 7）。
 *
 * 规则：没有数据的字段不显示，不出现「数据未提供」；解决率样本不足时显示「样本不足」，绝不显示 0%。
 */
import type { ExpertTemplate, OutputType, TemplatePricing, TemplateStats } from "../experts/types";

export const OUTPUT_TYPE_LABELS: Record<OutputType, string> = {
  document: "文档",
  spreadsheet: "表格",
  code: "代码",
  presentation: "演示",
  system_operation: "操作外部系统",
};

const TAGLINE_MAX_LENGTH = 40;
export const CARD_TAG_LIMIT = 3;
export const CARD_OUTPUT_TYPE_LIMIT = 4;
export const CARD_METRIC_SLOTS = 3;

/** 一句话定位；缺失时取岗位描述前 40 字（按码点截断）。 */
export function cardTagline(template: ExpertTemplate): string {
  if (template.tagline) return template.tagline;
  const description = [...(template.description || template.persona || "").trim()];
  return description.length > TAGLINE_MAX_LENGTH
    ? `${description.slice(0, TAGLINE_MAX_LENGTH).join("")}…`
    : description.join("");
}

const BILLING_PERIOD_UNITS: Record<NonNullable<TemplatePricing["billing_period"]>, string> = { month: "月", year: "年" };

/** $0.05/次、$0.3/百万 Token、$99/月、$999/年；套餐没有可识别的周期时显示「$99 套餐」。 */
export function formatPricing(pricing: TemplatePricing): string {
  const price = `$${Number(pricing.unit_price)}`;
  if (pricing.mode === "per_call") return `${price}/次`;
  if (pricing.mode === "per_token") return `${price}/百万 Token`;
  const unit = pricing.billing_period ? BILLING_PERIOD_UNITS[pricing.billing_period] : undefined;
  return unit ? `${price}/${unit}` : `${price} 套餐`;
}

export type RateTone = "success" | "primary" | "warning";

/** ≥80% 成功色，60%–80% 常规色，<60% 警告色。 */
export function rateTone(rate: number): RateTone {
  if (rate >= 0.8) return "success";
  if (rate >= 0.6) return "primary";
  return "warning";
}

export function formatRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export interface CardMetric {
  label: string;
  value: string;
  tone?: RateTone;
}

/** 卡片关键指标：按 解决率 / 计价 / 技能数 / 默认模型 的优先级取前 3 个有数据的。 */
export function cardMetrics(template: ExpertTemplate): CardMetric[] {
  const rate = template.stats?.resolution_rate;
  const skills = template.platform_skill_refs?.length || template.skill_ids?.length || 0;
  const model = template.platform_model_ref?.model_id;
  const candidates: Array<CardMetric | null> = [
    rate != null ? { label: "解决率", value: formatRate(rate), tone: rateTone(rate) } : null,
    template.pricing ? { label: "计价", value: formatPricing(template.pricing) } : null,
    skills > 0 ? { label: "技能", value: `${skills} 项` } : null,
    model ? { label: "模型", value: model } : null,
  ];
  return candidates.filter((metric): metric is CardMetric => metric !== null).slice(0, CARD_METRIC_SLOTS);
}

/** 详情页质量行：无统计时返回 null（区块隐藏）；样本不足时给出说明而不是 0%。 */
export function resolutionRateText(stats: TemplateStats): string {
  if (stats.resolution_rate == null) {
    return `样本不足（已评估 ${stats.evaluated_segments} 段，满 ${stats.min_sample} 段后显示）`;
  }
  return `${formatRate(stats.resolution_rate)}（已评估 ${stats.evaluated_segments} 段）`;
}
