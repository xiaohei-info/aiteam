"""A2 验收：@提及解析（群聊编排第一步）。

群聊 = 单机多专家协作（06 §7.6 / D19）。本轮触发哪些专家由消息里的 @提及决定。
解析是纯函数：从消息文本里抽出 @handle，按 roster 解析为本轮要起 run 的专家集合。

测试覆盖：主路径（解析出多个专家）、去重、未知 handle 忽略、@ 回环防护
（专家产出不得再触发 @ —— 红线）、大小写/边界。
"""

from agent_service.mainline.mentions import parse_mentions, resolve_mentions
from agent_service.mainline.group import GroupExpert


def _roster() -> dict[str, GroupExpert]:
    return {
        "alice": GroupExpert(handle="alice", system_prompt="你是 Alice"),
        "bob": GroupExpert(handle="bob", system_prompt="你是 Bob", model="m1"),
        "carol": GroupExpert(handle="carol", system_prompt="你是 Carol"),
    }


def test_parse_extracts_handles():
    assert parse_mentions("@alice 帮我看看 @bob") == ["alice", "bob"]


def test_parse_dedup_preserves_first_order():
    assert parse_mentions("@bob @alice @bob") == ["bob", "alice"]


def test_parse_no_mentions_returns_empty():
    assert parse_mentions("没有提及任何人") == []
    assert parse_mentions("邮箱 foo@bar.com 不是提及") == []  # @ 前有字符不算 handle


def test_parse_handle_charset():
    # 仅允许 字母/数字/下划线/连字符 的 handle；标点终止 handle。
    assert parse_mentions("@alice, @bob! @carol。") == ["alice", "bob", "carol"]


def test_resolve_filters_unknown_handles():
    roster = _roster()
    experts = resolve_mentions("@alice @dave @bob", roster)
    assert [e.handle for e in experts] == ["alice", "bob"]  # dave 不在 roster -> 忽略


def test_resolve_blocks_self_mention_loop():
    """@ 回环红线：专家产出再 @ 自己/他人不得形成自激循环。

    resolve 时显式排除发起方专家自身（exclude_handle），避免专家 @自己 触发新 run。
    """
    roster = _roster()
    experts = resolve_mentions("@alice @bob", roster, exclude_handle="alice")
    assert [e.handle for e in experts] == ["bob"]  # alice 自身被排除


def test_resolve_empty_when_only_self():
    roster = _roster()
    assert resolve_mentions("@alice", roster, exclude_handle="alice") == []
