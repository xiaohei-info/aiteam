"""Agent 用户端本地库底座（SQLite）。

**agent 本地库**：用户端轻量本地库（CLAUDE/AGENTS §12），单租户、单写者、localhost、
每用户一套——SQLite 嵌入式无独立进程、零运维、单文件备份，正是其靶心。Manager 多租户
RLS 底座（shared/db）不适用本端（无 tenant 路由）。

本模块是 #158 落地、#159/#179 复用的底座：
- `LocalDb`：持单连接 + 写锁，提供锁内的 execute/query/transaction（async 处理器与
  threadpool sync 处理器跨线程共用一连接，故 check_same_thread=False + Lock 串行化）。
- `apply_migrations`：按文件名排序应用 `migrations/*.sql`，`schema_migrations` 跟踪，
  幂等。后续仓储（loop/usage/grants/raw 归档）只追加 SQL 文件即复用。
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


class LocalDb:
    """本地 SQLite 连接 + 写锁封装。所有读写在锁内串行，保证跨线程安全与游标分配原子性。"""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._lock = threading.Lock()

    def execute(self, sql: str, params: Sequence = ()) -> None:
        with self._lock:
            self._conn.execute(sql, params)
            self._conn.commit()

    def executescript(self, script: str) -> None:
        """执行多语句脚本（迁移用）。注意 sqlite3.executescript 会先隐式 COMMIT，
        且不保证语句级回滚——故迁移脚本必须自身幂等（见 apply_migrations）。"""
        with self._lock:
            self._conn.executescript(script)
            self._conn.commit()

    def query(self, sql: str, params: Sequence = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    def query_one(self, sql: str, params: Sequence = ()) -> sqlite3.Row | None:
        with self._lock:
            return self._conn.execute(sql, params).fetchone()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """锁内事务：用于"读-改-写"需原子的场景（如 timeline 游标分配）。"""
        with self._lock:
            try:
                yield self._conn
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise

    def close(self) -> None:
        with self._lock:
            self._conn.close()


def connect(db_path: str) -> LocalDb:
    """打开（必要时创建）本地库文件。`:memory:` 透传用于测试。"""
    if db_path != ":memory:":
        Path(db_path).expanduser().parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return LocalDb(conn)


def _split_statements(script: str):
    """Split a SQL script into statements, respecting parens/quotes/newlines so
    multi-line CREATE TABLE(...) / DO-blocks stay intact."""
    stmts: list[str] = []
    buf: list[str] = []
    in_single = in_double = in_line_comment = in_block_comment = False
    prev = ""
    i = 0
    n = len(script)
    while i < n:
        c = script[i]
        two = c + script[i + 1] if i + 1 < n else c
        if in_line_comment:
            buf.append(c)
            if c == "\n":
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            buf.append(c)
            if two == "*/":
                buf.append(script[i + 1])
                in_block_comment = False
                i += 2
            else:
                i += 1
            continue
        if in_single:
            buf.append(c)
            if c == "\\":
                if i + 1 < n:
                    buf.append(script[i + 1])
                    i += 2
                else:
                    i += 1
                continue
            if c == "'":
                in_single = False
            i += 1
            continue
        if in_double:
            buf.append(c)
            if c == '"':
                in_double = False
            i += 1
            continue
        if two == "--":
            in_line_comment = True
            buf.append(two)
            i += 2
            continue
        if two == "/*":
            in_block_comment = True
            buf.append(two)
            i += 2
            continue
        if c == "'":
            in_single = True
            buf.append(c)
            i += 1
            continue
        if c == '"':
            in_double = True
            buf.append(c)
            i += 1
            continue
        if c == ";" and not in_single and not in_double:
            stmts.append("".join(buf).strip())
            buf = []
            i += 1
            continue
        buf.append(c)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        stmts.append(tail)
    return [st for st in stmts if st]


def _apply_one_migration(db: LocalDb, script: str) -> None:
    """Apply a single migration defensively so re-running a half-applied script is safe.

    Splits the script into statements (respecting parens/quotes), then runs each one. For the
    common ALTER TABLE ADD COLUMN case we PRAGMA-check first; any statement that fails with the
    benign "duplicate column name" / already-exists error is skipped so partial re-runs recover.
    """
    import re
    import sqlite3
    con = db._conn
    statements = _split_statements(script)
    with db._lock:
        for stmt in statements:
            alter_match = re.match(r"^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\b\w+)\b", stmt, re.IGNORECASE)
            if alter_match:
                tbl, col = alter_match.group(1), alter_match.group(2)
                existing = con.execute(f"PRAGMA table_info({tbl})").fetchall()
                if any(row["name"] == col for row in existing):
                    continue
            try:
                con.execute(stmt)
            except sqlite3.OperationalError as exc:
                # Skip benign duplicate-column errors (idempotent re-run).
                msg = str(exc)
                if "duplicate column name" in msg or "already exists" in msg:
                    continue
                raise
        con.commit()


def _list_columns(con, table: str) -> set[str]:
    return {row["name"] for row in con.execute(f"PRAGMA table_info({table})").fetchall()}


def apply_migrations(db: LocalDb, migrations_dir: Path = MIGRATIONS_DIR) -> list[str]:
    """按文件名顺序应用未应用的 `*.sql`，返回本次新应用的文件名。

    ⚠️ **迁移脚本必须自身幂等**（全程 `IF NOT EXISTS` / 防御式 DDL）。`executescript`
    会先隐式 COMMIT 且**不保证语句级回滚**——多语句脚本中途失败时已执行的语句不回滚，
    只有 `schema_migrations` 跟踪行未写入，故下次启动会**整脚本重跑**。幂等脚本下重跑自愈；
    非幂等 DDL（ALTER/数据回填）请拆成独立、可重入的小步，勿依赖"整批原子"。
    """
    # 每步独立提交，不用整批事务包裹（executescript 本就会打断事务，避免造成"原子"错觉）。
    db.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations "
        "(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    applied = {row["name"] for row in db.query("SELECT name FROM schema_migrations")}
    newly: list[str] = []
    for path in sorted(migrations_dir.glob("*.sql")):
        if path.name in applied:
            continue
        _apply_one_migration(db, path.read_text(encoding="utf-8"))
        db.execute("INSERT INTO schema_migrations(name) VALUES (?)", (path.name,))
        newly.append(path.name)
    return newly
