"""部门层级校验：防环、层数上限、上级必须存在。"""

import pytest

from manager_service.department_tree import (
    MAX_DEPARTMENT_DEPTH,
    DepartmentDepthExceeded,
    DepartmentInvalidMove,
    check_parent,
    check_promote,
)
from shared.errors import NotFound, ValidationProblem

# a -> b -> c，d 独立顶级
PARENTS = {"a": None, "b": "a", "c": "b", "d": None}


def test_top_level_is_always_allowed():
    check_parent(PARENTS, None, moving="c")
    check_parent(PARENTS, None)


def test_parent_must_exist():
    with pytest.raises(NotFound):
        check_parent(PARENTS, "zzz")


def test_cannot_move_under_self_or_descendant():
    with pytest.raises(ValidationProblem):
        check_parent(PARENTS, "a", moving="a")
    with pytest.raises(ValidationProblem):
        check_parent(PARENTS, "c", moving="a")


def test_valid_move_to_sibling_branch():
    check_parent(PARENTS, "d", moving="b")


def test_depth_limit_counts_the_whole_moved_subtree():
    chain = {f"n{i}": (f"n{i - 1}" if i else None) for i in range(MAX_DEPARTMENT_DEPTH)}
    with pytest.raises(ValidationProblem):
        check_parent(chain, f"n{MAX_DEPARTMENT_DEPTH - 1}")
    # a(3 层子树)挂到 d 下共 4 层，允许；再挂到更深处则超限
    check_parent(PARENTS, "d", moving="a")
    deeper = {**PARENTS, "e": "d", "f": "e", "g": "f"}
    with pytest.raises(ValidationProblem):
        check_parent(deeper, "g", moving="a")


def test_existing_cycle_in_data_does_not_loop_forever():
    check_parent({"x": "y", "y": "x", "z": None}, "z")


def test_promote_swaps_parent_and_child_and_keeps_other_branches():
    # a -> b -> c ; a -> x ; c -> e
    parents = {"a": None, "b": "a", "c": "b", "x": "a", "e": "c", "z": None}
    new = check_promote(parents, "a", "c")
    assert new["c"] is None and new["a"] == "c"
    assert new["x"] == "a" and new["b"] == "a" and new["e"] == "c"


def test_promote_keeps_original_parent_of_target():
    parents = {"r": None, "a": "r", "c": "a"}
    assert check_promote(parents, "a", "c") == {"r": None, "a": "c", "c": "r"}


def test_promote_requires_descendant_and_known_ids():
    parents = {"a": None, "b": "a", "d": None}
    with pytest.raises(ValidationProblem):
        check_promote(parents, "a", "d")
    with pytest.raises(ValidationProblem):
        check_promote(parents, "b", "a")
    with pytest.raises(NotFound):
        check_promote(parents, "a", "zzz")


def test_promote_respects_depth_limit():
    # n1..n5 为 5 层链，a 挂在 n2 下带 b、c；c 升级后 a、b 压到 c 下 -> 超限
    parents = {"n1": None, "n2": "n1", "a": "n2", "c": "a", "b": "a", "y": "b", "m": "y"}
    with pytest.raises(ValidationProblem):
        check_promote(parents, "a", "c")


def test_errors_carry_stable_codes_not_just_text():
    with pytest.raises(DepartmentInvalidMove) as moved:
        check_parent(PARENTS, "c", moving="a")
    assert moved.value.code == "department_invalid_move" and moved.value.status == 422
    chain = {str(i): (str(i - 1) if i else None) for i in range(MAX_DEPARTMENT_DEPTH)}
    chain["x"] = None
    with pytest.raises(DepartmentDepthExceeded) as deep:
        check_parent(chain, str(MAX_DEPARTMENT_DEPTH - 1), moving="x")
    assert deep.value.code == "department_depth_exceeded"
    with pytest.raises(DepartmentInvalidMove):
        check_promote(PARENTS, "d", "c")
