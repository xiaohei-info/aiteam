"""部门层级校验（纯函数，不碰数据库）。

层级只表达组织结构：成员/专家授权按部门精确匹配，不沿层级继承。
"""

from __future__ import annotations

from collections.abc import Mapping

from shared.errors import NotFound, ValidationProblem

# 顶级部门为第 1 层。
MAX_DEPARTMENT_DEPTH = 5


def _depth(parents: Mapping[str, str | None], department_id: str) -> int:
    """部门所在层数（顶级为 1）。数据里若已存在环，按“看到重复节点即停”处理，不会死循环。"""
    depth, seen, current = 0, set(), department_id
    while current is not None and current not in seen:
        seen.add(current)
        depth += 1
        current = parents.get(current)
    return depth


def _height(parents: Mapping[str, str | None], department_id: str) -> int:
    """以该部门为根的子树层数（只有自己为 1）。"""
    children: dict[str, list[str]] = {}
    for child, parent in parents.items():
        if parent is not None:
            children.setdefault(parent, []).append(child)
    best, stack, seen = 0, [(department_id, 1)], set()
    while stack:
        node, level = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        best = max(best, level)
        stack.extend((child, level + 1) for child in children.get(node, []))
    return best


def check_parent(parents: Mapping[str, str | None], parent_id: str | None, *, moving: str | None = None) -> None:
    """校验把 `moving`（新建时为 None）放到 `parent_id` 下是否合法，不合法则抛业务错误。

    parents 是本租户全部 部门id -> 上级id 的映射（顶级为 None）。
    """
    if parent_id is None:
        return
    if parent_id not in parents:
        raise NotFound("parent department not found in this tenant")
    if moving is not None:
        if parent_id == moving:
            raise ValidationProblem("a department cannot be its own parent")
        # 沿上级链往上走，遇到被移动的部门就说明目标在它的子树里。
        current, seen = parent_id, set()
        while current is not None and current not in seen:
            if current == moving:
                raise ValidationProblem("a department cannot be moved under its own sub-department")
            seen.add(current)
            current = parents.get(current)
    subtree = _height(parents, moving) if moving is not None else 1
    if _depth(parents, parent_id) + subtree > MAX_DEPARTMENT_DEPTH:
        raise ValidationProblem(f"department hierarchy is limited to {MAX_DEPARTMENT_DEPTH} levels")


def check_promote(parents: Mapping[str, str | None], department_id: str, child_id: str) -> dict[str, str | None]:
    """下级 `child_id` 升级：取代 `department_id` 的位置，原部门成为它的子部门。

    原部门的其他子部门仍跟着原部门，child 的原有子部门仍留在 child 下。
    校验通过返回新的 部门id -> 上级id 映射，否则抛业务错误。
    """
    if department_id not in parents or child_id not in parents:
        raise NotFound("department not found in this tenant")
    current, seen, is_descendant = parents.get(child_id), set(), False
    while current is not None and current not in seen:
        if current == department_id:
            is_descendant = True
            break
        seen.add(current)
        current = parents.get(current)
    if not is_descendant:
        raise ValidationProblem("promoted department must be a sub-department of the target")
    top = parents[department_id]
    updated = {**parents, child_id: top, department_id: child_id}
    base = 0 if top is None else _depth(updated, top)
    if base + _height(updated, child_id) > MAX_DEPARTMENT_DEPTH:
        raise ValidationProblem(f"department hierarchy is limited to {MAX_DEPARTMENT_DEPTH} levels")
    return updated
