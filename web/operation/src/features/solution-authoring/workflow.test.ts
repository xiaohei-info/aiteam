import { describe, expect, it } from "vitest";
import {
  friendlyError, primaryAction, referencedMembers, removalBlocker, ruleParts, submitBlockers, validateRules, workflowSteps,
} from "./workflow";
import type { DraftDetail, Gate } from "./types";

function detail(overrides: Record<string, unknown> = {}): DraftDetail {
  return { status: "ready_for_review", sources: [{}], open_finding_count: 0, gates: [], package: {}, publish_started: false, ...overrides } as unknown as DraftDetail;
}
const gate = (key: Gate["key"], ok: boolean): Gate => ({ key, ok, message: "" });

describe("workflowSteps", () => {
  it("没有资料时停在「资料」，并写出阻塞文字", () => {
    const steps = workflowSteps(detail({ status: "draft", sources: [], package: null }));
    expect(steps.map((s) => s.state)).toEqual(["current", "todo", "todo", "todo", "todo"]);
    expect(steps[0]!.blocker).toBe("上传至少一份行业资料");
  });

  it("确认步骤列出全部阻塞项", () => {
    const steps = workflowSteps(detail({ open_finding_count: 2, gates: [gate("coordinator", false), gate("rules", false)] }));
    expect(steps[2]).toMatchObject({ state: "current", blocker: "还差 2 项敏感项未处理；群主与编排规则未确认" });
    expect(steps[1]!.state).toBe("done");
  });

  it("已发布全部完成；驳回退回「确认」", () => {
    expect(workflowSteps(detail({ status: "published" })).every((s) => s.state === "done")).toBe(true);
    const rejected = workflowSteps(detail({ status: "rejected" }));
    expect(rejected[2]).toMatchObject({ state: "current", blocker: "已驳回：按理由修改后重新提交" });
  });
});

describe("primaryAction", () => {
  it("一个状态一个主操作", () => {
    expect(primaryAction(detail({ status: "draft", sources: [] }), false, false)?.kind).toBe("upload");
    expect(primaryAction(detail({ status: "draft" }), false, false)?.kind).toBe("generate");
    expect(primaryAction(detail({ status: "generating" }), true, false)).toBeNull();
    expect(primaryAction(detail({ status: "in_review" }), false, false)).toBeNull();
    expect(primaryAction(detail({ status: "in_review" }), true, false)?.label).toBe("审核通过");
    expect(primaryAction(detail({ status: "approved", publish_started: true }), true, false)?.label).toBe("重新发布");
  });

  it("提交审核不可用时给出文字原因", () => {
    expect(primaryAction(detail(), false, true)?.disabledReason).toContain("未保存");
    expect(primaryAction(detail({ open_finding_count: 1 }), false, false)?.disabledReason).toBe("还差 1 项敏感项未处理");
    expect(primaryAction(detail(), false, false)?.disabledReason).toBeUndefined();
  });
});

describe("编排规则引用", () => {
  const keys = ["lead", "qc"];
  it("校验与后端口径一致", () => {
    expect(validateRules("@{lead} 先拆解，@{qc} 检验", keys, "group")).toBeNull();
    expect(validateRules("  ", keys, "group")).toBe("组群方案必须写出群聊编排规则");
    expect(validateRules("@{ghost} 做事", keys, "group")).toContain("ghost");
    expect(validateRules("@{lead 缺括号", keys, "group")).toContain("格式不对");
    expect(validateRules("", keys, "solo")).toBeNull();
    expect(validateRules("x", keys, "solo")).toContain("不需要");
  });

  it("预览把引用拆成成员，未知引用标记 known=false", () => {
    const solution = { experts: [{ key: "lead", display_name: "协调员" }] } as never;
    expect(ruleParts("a @{lead} b @{x}", solution)).toEqual([
      { kind: "text", text: "a " },
      { kind: "member", key: "lead", name: "协调员", known: true },
      { kind: "text", text: " b " },
      { kind: "member", key: "x", name: "x", known: false },
    ]);
    expect(referencedMembers("@{a}@{a}@{b}")).toEqual(["a", "b"]);
  });

  it("规则仍引用的专家不能删除", () => {
    expect(removalBlocker("@{qc} 检验", "qc")).not.toBeNull();
    expect(removalBlocker("@{lead} 先", "qc")).toBeNull();
    expect(removalBlocker(undefined, "qc")).toBeNull();
  });
});

describe("friendlyError / submitBlockers", () => {
  it("英文错误中文化，中文与未知原样返回", () => {
    expect(friendlyError("orchestration rules are required for a group solution")).toBe("组群方案必须先写出群聊编排规则");
    expect(friendlyError("已经是中文")).toBe("已经是中文");
    expect(friendlyError("totally unknown")).toBe("totally unknown");
  });
  it("没有阻塞项返回空数组", () => {
    expect(submitBlockers({ open_finding_count: 0, gates: [gate("findings", true)] })).toEqual([]);
  });
});
