import { describe, expect, it } from "vitest";
import { descendantIds, flattenDepartments, MAX_DEPARTMENT_DEPTH, selectableParents, subtreeHeight } from "../departmentTree";
import type { Department } from "../types";

const dept = (id: string, parent_id: string | null = null): Department => ({
  id, department_slug: id, display_name: id, created_at: null, parent_id,
});

describe("departmentTree", () => {
  const list = [dept("a"), dept("b", "a"), dept("c", "b"), dept("d"), dept("x", "a")];

  it("按层级先序展开并给出层数", () => {
    expect(flattenDepartments(list).map(({ department, depth }) => `${department.id}:${depth}`)).toEqual(["a:1", "b:2", "c:3", "x:2", "d:1"]);
  });

  it("上级缺失或自指向的部门按顶级处理，环不会死循环", () => {
    const nodes = flattenDepartments([dept("o", "missing"), dept("s", "s"), dept("p", "q"), dept("q", "p")]);
    expect(nodes.filter(({ depth }) => depth === 1).map(({ department }) => department.id)).toEqual(["o", "s"]);
    expect(nodes.map(({ department }) => department.id)).not.toContain("p");
  });

  it("没有 parent_id 字段的旧数据全部是顶级", () => {
    const legacy = [{ id: "a", department_slug: "a", display_name: "a", created_at: null }];
    expect(flattenDepartments(legacy).map(({ depth }) => depth)).toEqual([1]);
  });

  it("下级集合和子树层数", () => {
    expect([...descendantIds(list, "a")].sort()).toEqual(["a", "b", "c", "x"]);
    expect(subtreeHeight(list, "a")).toBe(3);
    expect(subtreeHeight(list, "d")).toBe(1);
  });

  it("可选上级排除自己和下级，并受最大层数限制", () => {
    expect(selectableParents(list, "a").map(({ department }) => department.id)).toEqual(["d"]);
    expect(selectableParents(list).map(({ department }) => department.id)).toEqual(["a", "b", "c", "x", "d"]);
    const chain = Array.from({ length: MAX_DEPARTMENT_DEPTH }, (_, i) => dept(`n${i}`, i ? `n${i - 1}` : null));
    expect(selectableParents(chain).map(({ department }) => department.id)).not.toContain(`n${MAX_DEPARTMENT_DEPTH - 1}`);
    // 带一个下级的部门（2 层）不能挂到第 4 层下面
    expect(selectableParents([...chain, dept("m"), dept("m1", "m")], "m").map(({ department }) => department.id)).not.toContain("n3");
  });
});
