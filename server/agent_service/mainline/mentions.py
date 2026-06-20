"""@提及解析（群聊编排第一步，06 §7.6 / D19）。

群聊 = 单机多专家协作。本轮触发哪些专家，由消息文本里的 @提及决定。本模块是**纯函数**：
    parse_mentions(text)            -> 去重保序的 handle 列表
    resolve_mentions(text, roster)  -> 解析为 roster 内已知专家（未知 handle 忽略）

防回环（红线）：resolve 支持 exclude_handle，排除发起方专家自身——专家产出再 @自己不得
形成自激循环。注意这只是解析层的一道闸；编排层（group.py）还有"只有 USER 消息进编排"
的更强约束。

handle 字符集：字母/数字/下划线/连字符；@ 前必须是行首或非单词字符（避免把
foo@bar.com 误判为提及）。
"""

from __future__ import annotations

import re

# (?<![\w@]) 守卫：@ 前不能紧跟单词字符或 @（排除 email 局部、@@ 等）。
_MENTION_RE = re.compile(r"(?<![\w@])@([A-Za-z0-9_-]+)")


def parse_mentions(text: str) -> list[str]:
    """抽出文本里的 @handle，去重并保留首次出现顺序。"""
    seen: dict[str, None] = {}
    for m in _MENTION_RE.finditer(text):
        seen.setdefault(m.group(1), None)
    return list(seen)


def resolve_mentions(text, roster, *, exclude_handle: str | None = None):
    """把文本里的 @提及解析为 roster 内已知专家列表（保序）。

    - 未知 handle（不在 roster）静默忽略。
    - exclude_handle：排除该 handle（防回环——发起方专家不得 @ 触发自身）。
    返回 GroupExpert 列表（类型见 group.py，避免循环 import 不在签名标注）。
    """
    return [
        roster[h]
        for h in parse_mentions(text)
        if h in roster and h != exclude_handle
    ]
