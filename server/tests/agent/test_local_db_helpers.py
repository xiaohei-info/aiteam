"""agent_service/local_db.py — 纯函数助手验收（_split_statements / _apply_one_migration）。

这些是 PR #12 加入的 SQL 分词/迁移防御逻辑；与 I/O 隔离，直接用输入/预期输出校验。
"""

from __future__ import annotations

from agent_service.local_db import _split_statements


def test_split_empty():
    assert _split_statements("") == []


def test_split_single_statement():
    assert _split_statements("SELECT 1;") == ["SELECT 1"]


def test_split_multiple_semicolons():
    stmts = _split_statements("SELECT 1; SELECT 2; SELECT 3;")
    assert stmts == ["SELECT 1", "SELECT 2", "SELECT 3"]


def test_split_respects_semicolon_in_single_quoted_string():
    """单引号内的分号不应切分。覆盖 line 112-119 单引号分支。"""
    stmts = _split_statements("INSERT INTO t VALUES ('a;b'); SELECT 1;")
    assert stmts == ["INSERT INTO t VALUES ('a;b')", "SELECT 1"]


def test_split_respects_semicolon_in_double_quoted_string():
    """双引号内的分号不应切分。覆盖 line 122-125 双引号分支。"""
    stmts = _split_statements('INSERT INTO t VALUES ("x;y"); SELECT 1;')
    assert stmts == ['INSERT INTO t VALUES ("x;y")', "SELECT 1"]


def test_split_respects_double_dash_line_comment():
    """行内 -- 注释后的分号（含换行前的）不应形成孤立 statement。覆盖 line 98-102。"""
    sql = "SELECT 1; -- a;b\n SELECT 2;"
    stmts = _split_statements(sql)
    assert stmts == ['SELECT 1', '-- a;b\n SELECT 2']


def test_split_respects_block_comment():
    """块注释 /* */ 内的分号不应切分。覆盖 line 103-110。"""
    sql = "SELECT /* a;b */ 1; SELECT 2;"
    stmts = _split_statements(sql)
    assert stmts == ["SELECT /* a;b */ 1", "SELECT 2"]


def test_split_respects_backslash_escape_in_quote():
    """单引号内转义 \\ 不应吃掉下一个字符/提前闭合。覆盖 line 115-118。"""
    sql = "SELECT 'it''s;tricky'; SELECT 2;"
    stmts = _split_statements(sql)
    assert stmts == ["SELECT 'it''s;tricky'", "SELECT 2"]


def test_split_trailing_no_semicolon():
    """末尾无分号也要落成一条 statement（尾段落盘）。覆盖 line 152-154。"""
    assert _split_statements("SELECT 1") == ["SELECT 1"]
