import { describe, expect, it } from "vitest";
import { validateRegistration } from "./validation";

describe("validateRegistration", () => {
  it("返回行业方案的必填字段与结构化 JSON 错误", () => {
    expect(
      validateRegistration({
        catalogType: "solution_template",
        displayName: "  ",
        category: "",
        avatarUrl: "",
        systemPrompt: "",
        defaultModel: "",
        description: "",
        expertTemplateIds: [],
        coordinatorTemplateId: "",
      }),
    ).toEqual({
      displayName: "名称不能为空",
      expertTemplateIds: "请至少选择一个专家模板",
      coordinatorTemplateId: "请选择一个协调专家",
    });
  });

  it("专家模板校验必填字段与 JSON 数组", () => {
    expect(
      validateRegistration({
        catalogType: "expert_template",
        displayName: "客服专家",
        category: "",
        avatarUrl: "",
        systemPrompt: "",
        defaultModel: "",
        description: "",
        expertTemplateIds: [],
        coordinatorTemplateId: "",
      }),
    ).toEqual({
      category: "请选择分类",
      systemPrompt: "请填写系统提示词",
      defaultModel: "请填写默认模型",
      description: "请填写岗位描述",
    });
  });
});
