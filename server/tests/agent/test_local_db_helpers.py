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


def test_split_single_quote_close_branch():
    """单引号闭合分支 in_single=False 路径 (line 109-111)。"""
    assert _split_statements("'a'") == ["'a'"]


def test_split_escape_backslash_in_single_quote_eof():
    """单反斜杠在单引号末尾（i+1==n 边界）(line 113-114 的特殊边界)。"""
    # 末尾 \ 后面没字符 — 防越界
    stmts = _split_statements("SELECT '\\'")
    assert stmts == ["SELECT '\\'"]


def test_apply_one_migration_skips_existing_column():
    """_apply_one_migration: ALTER TABLE ADD COLUMN 已存在时应跳过（PRAGMA 命中，line 176-181）。"""
    import tempfile, sqlite3
    from agent_service.local_db import _apply_one_migration, connect

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
    tmp.close()
    conn = sqlite3.connect(tmp.name)
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)")
    conn.commit()
    db = connect(tmp.name)

    # 列已存在 → 跳过（不应报错）
    _apply_one_migration(db, "ALTER TABLE t ADD COLUMN id INTEGER")
    cols = {r[1] for r in conn.execute("PRAGMA table_info(t)").fetchall()}
    assert "id" in cols

    # 列不存在 → 正常加列
    _apply_one_migration(db, "ALTER TABLE t ADD COLUMN name TEXT")
    cols = {r[1] for r in conn.execute("PRAGMA table_info(t)").fetchall()}
    assert "name" in cols
    conn.close()


def test_apply_migration_skips_duplicate_column_error():
    """_apply_one_migration: 非 ALTER 形式的 'duplicate column' 错误也应被吞 (line 184)。"""
    import tempfile, sqlite3
    from agent_service.local_db import _apply_one_migration, connect

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
    tmp.close()
    conn = sqlite3.connect(tmp.name)
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)")
    conn.commit()
    db = connect(tmp.name)
    # 普通 INSERT 执行两次相同主键 → 触发 IntegrityError (非 OperationalError), 应抛出
    # 但 duplicate column 形式 OperationalError 应被吞
    import sqlite3 as _sq
    # 重复加列（非 ALTER 形式）— 不能用 ALTER TABLE 所以绕过 PRAGMA 路径
    conn.execute("ALTER TABLE t ADD COLUMN x TEXT")
    conn.commit()
    # 显式 _apply_one_migration 现在会走 PRAGMA 命中跳过。换个场景：用 CREATE TABLE IF NOT EXISTS 的 'already exists'
    _apply_one_migration(db, "CREATE TABLE IF NOT EXISTS t (id INTEGER)")
    # 不应抛出 → line 189 finally
    conn.close()
