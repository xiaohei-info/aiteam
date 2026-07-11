import { describe, expect, it } from "vitest";
import { validateRegistration } from "./validation";

describe("validateRegistration", () => {
  it("返回行业方案的必填字段与结构化 JSON 错误", () => {
    expect(
      validateRegistration({
        catalogType: "solution_template",
        displayName: "  ",
        expertTemplateIds: [],
        plannerTemplateId: "",
        plannerPrompt: "",
        initialMemoriesText: "",
        defaultGrantsText: "not-json",
      }),
    ).toEqual({
      displayName: "名称不能为空",
      expertTemplateIds: "请至少选择一个专家模板",
      plannerTemplateId: "请指定一个专家为 Planner 角色（编排者）",
      plannerPrompt: "请填写 Planner 编排规则提示词",
      defaultGrantsText: "默认 Grants 必须是 JSON 对象",
    });
  });

  it("仅对专家模板校验 JSON 数组，并允许空的可选配置", () => {
    expect(
      validateRegistration({
        catalogType: "expert_template",
        displayName: "客服专家",
        expertTemplateIds: [],
        plannerTemplateId: "",
        plannerPrompt: "",
        initialMemoriesText: '{"role":"user"}',
        defaultGrantsText: "",
      }),
    ).toEqual({
      initialMemoriesText: "预置记忆必须是 JSON 数组",
    });
  });
});
