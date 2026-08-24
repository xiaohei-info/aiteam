import type { CatalogItemType } from "../types";

export interface RegistrationInput {
  catalogType: CatalogItemType;
  displayName: string;
  category: string;
  avatarUrl: string;
  systemPrompt: string;
  defaultModel: string;
  description: string;
  expertTemplateIds: string[];
  plannerTemplateId: string;
  plannerPrompt: string;
  defaultGrantsText: string;
}

export type RegistrationErrors = Partial<Record<keyof RegistrationInput, string>>;

export function parseList(value: string): string[] {
  return value
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const text = value.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export function validateRegistration(input: RegistrationInput): RegistrationErrors {
  const errors: RegistrationErrors = {};

  if (!input.displayName.trim()) errors.displayName = "名称不能为空";

  if (input.catalogType === "expert_template") {
    if (!input.category.trim()) errors.category = "请选择分类";
    if (!input.systemPrompt.trim()) errors.systemPrompt = "请填写系统提示词";
    if (!input.defaultModel.trim()) errors.defaultModel = "请填写默认模型";
    if (!input.description.trim()) errors.description = "请填写岗位描述";
    return errors;
  }

  if (input.expertTemplateIds.length === 0) {
    errors.expertTemplateIds = "请至少选择一个专家模板";
  }
  if (!input.plannerTemplateId.trim()) {
    errors.plannerTemplateId = "请指定一个专家为 Planner 角色（编排者）";
  }
  if (!input.plannerPrompt.trim()) {
    errors.plannerPrompt = "请填写 Planner 编排规则提示词";
  }
  if (input.defaultGrantsText.trim() && !parseJsonObject(input.defaultGrantsText)) {
    errors.defaultGrantsText = "默认 Grants 必须是 JSON 对象";
  }

  return errors;
}
