/** 部门层级的纯函数：展示顺序、可选上级、层数。规则与 Manager 的 department_tree.py 一致。 */
import type { Department } from "./types";

export const MAX_DEPARTMENT_DEPTH = 5;

export interface DepartmentNode {
  department: Department;
  depth: number; // 顶级为 1
}

/** 按层级先序展开；上级缺失的部门按顶级处理，同级保持输入顺序。 */
export function flattenDepartments(departments: readonly Department[]): DepartmentNode[] {
  const ids = new Set(departments.map((department) => department.id));
  const children = new Map<string | null, Department[]>();
  for (const department of departments) {
    const parent = department.parent_id && ids.has(department.parent_id) && department.parent_id !== department.id
      ? department.parent_id
      : null;
    children.set(parent, [...(children.get(parent) ?? []), department]);
  }
  const result: DepartmentNode[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const department of children.get(parent) ?? []) {
      if (seen.has(department.id)) continue; // 防御历史脏数据里的环
      seen.add(department.id);
      result.push({ department, depth });
      walk(department.id, depth + 1);
    }
  };
  walk(null, 1);
  return result;
}

function childrenOf(departments: readonly Department[], id: string): Department[] {
  return departments.filter((department) => department.parent_id === id);
}

/** 自己及所有下级的 id。 */
export function descendantIds(departments: readonly Department[], id: string): Set<string> {
  const result = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    for (const child of childrenOf(departments, stack.pop()!)) {
      if (!result.has(child.id)) { result.add(child.id); stack.push(child.id); }
    }
  }
  return result;
}

/** 以该部门为根的子树层数（只有自己为 1）。 */
export function subtreeHeight(departments: readonly Department[], id: string): number {
  const walk = (current: string, seen: Set<string>): number => {
    if (seen.has(current)) return 0;
    const next = new Set(seen).add(current);
    return 1 + Math.max(0, ...childrenOf(departments, current).map((child) => walk(child.id, next)));
  };
  return walk(id, new Set());
}

/**
 * `movingId` 可选的上级部门：不含自己和自己的下级，且移过去后整棵子树不超过最大层数。
 * 新建时 movingId 为 undefined（子树只有自己，1 层）。
 */
export function selectableParents(departments: readonly Department[], movingId?: string): DepartmentNode[] {
  const excluded = movingId ? descendantIds(departments, movingId) : new Set<string>();
  const height = movingId ? subtreeHeight(departments, movingId) : 1;
  return flattenDepartments(departments).filter(({ department, depth }) => !excluded.has(department.id) && depth + height <= MAX_DEPARTMENT_DEPTH);
}
