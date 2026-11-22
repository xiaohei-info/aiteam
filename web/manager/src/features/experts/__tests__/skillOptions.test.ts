import { describe, expect, it } from "vitest";
import type { SkillCatalog } from "../../capability/types";
import { buildSkillOptions, danglingSkillRefs, skillAvailability, skillRefKey } from "../skillOptions";

const skill = (skill_id: string, extra: Partial<SkillCatalog> = {}): SkillCatalog => ({
  catalog_id: `c-${skill_id}`, skill_id, display_name: skill_id, version: "1", install_policy: "on_demand",
  binding_policy: "opt_in", visibility: "tenant", config: {}, catalog_version: 1, package_status: "ready", ...extra,
});

describe("skillOptions", () => {
  it("引用可以带版本，目录身份只认 skill_id", () => {
    expect(skillRefKey("weekly@1.2")).toBe("weekly");
    expect(skillRefKey("weekly")).toBe("weekly");
  });

  it("可用性与后端签发条件一致：停用、草稿、无效不可用", () => {
    expect(skillAvailability(skill("a"))).toBe("ready");
    expect(skillAvailability(skill("a", { binding_policy: "disabled" }))).toBe("disabled");
    expect(skillAvailability(skill("a", { package_status: "draft" }))).toBe("draft");
    expect(skillAvailability(skill("a", { package_status: "invalid" }))).toBe("invalid");
  });

  it("不可用的置灰并写明原因；员工已经选着的不置灰，管理员才能取消", () => {
    const skills = [
      skill("weekly", { display_name: "周报整理", version: "1.2" }),
      skill("ppt", { display_name: "汇报 PPT 大纲", package_status: "draft" }),
      skill("old", { display_name: "合同审阅", binding_policy: "disabled" }),
    ];
    const options = buildSkillOptions(skills, ["old"]);
    expect(options[0]).toEqual({ value: "weekly", label: "周报整理 · v1.2" });
    expect(options[1]).toMatchObject({ value: "ppt", disabled: true });
    expect(options[1]?.label).toContain("还没完成，暂时不能给员工用");
    expect(options[2]).toMatchObject({ value: "old", disabled: false });
    expect(options[2]?.label).toContain("已被停用");
  });

  it("找出员工已有但企业技能库里没有的引用（含带版本的写法）", () => {
    const skills = [skill("weekly")];
    expect(danglingSkillRefs(skills, ["weekly@1", "gone", "gone2@3"])).toEqual(["gone", "gone2@3"]);
    expect(danglingSkillRefs(skills, [])).toEqual([]);
  });
});
