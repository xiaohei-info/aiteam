import { describe, expect, it } from "vitest";

import { parseTags, validateProfile } from "./profile";

describe("企业资料校验", () => {
  it("标签按中英文逗号与换行拆分、去空去重", () => {
    expect(parseTags("华东，KA, KA,\n  ")).toEqual(["华东", "KA"]);
  });

  it("三种超限分别提示", () => {
    expect(validateProfile("制造业", ["KA"])).toBeNull();
    expect(validateProfile("x".repeat(21), [])).toBe("所属行业不超过 20 字");
    expect(validateProfile("", Array.from({ length: 11 }, (_, i) => `t${i}`))).toBe("企业标签最多 10 个");
    expect(validateProfile("", ["x".repeat(21)])).toBe(`标签「${"x".repeat(21)}」超过 20 字`);
  });
});
