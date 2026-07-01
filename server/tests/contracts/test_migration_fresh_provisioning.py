"""全新环境可自举的迁移静态闸门（feature 分支作为全新环境部署的前提）。

背景：这些缺陷只在**全新库**（库名非 manager_control_db、无历史表）首次跑迁移时暴露，
既有库/CI 若始终对同一命名库跑迁移则测不到。故用静态断言把这一类"只在 fresh deploy
崩"的写法钉死在仓库里，不依赖真实 PG（默认门即可跑）。

守两条：
1) 授权语句不得硬编码数据库名（`GRANT ... ON DATABASE <name>`）——库名在全新环境可为
   aiteam_v1 等；CONNECT 授权由 apply_migrations 用 current_database() 动态下发。
2) 幂等守卫不得引用 `pg_tables.forcerowsecurity`（该视图无此列，全新库直接报错）；
   ENABLE/FORCE ROW LEVEL SECURITY 本身幂等，无需守卫。
"""

from __future__ import annotations

import pathlib
import re

_SERVER_ROOT = pathlib.Path(__file__).resolve().parents[2]
_MIGRATION_DIRS = [
    _SERVER_ROOT / "manager_service" / "migrations",
    _SERVER_ROOT / "operation_service" / "migrations",
]

# 去掉行内 `--` 注释后再匹配（这些迁移里 `--` 不出现在字符串字面量中）。
_ON_DATABASE = re.compile(r"\bON\s+DATABASE\s+\w+", re.IGNORECASE)


def _migration_files() -> list[pathlib.Path]:
    files: list[pathlib.Path] = []
    for d in _MIGRATION_DIRS:
        if d.is_dir():
            files.extend(sorted(d.glob("*.sql")))
    return files


def _uncommented(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def test_migration_dirs_present() -> None:
    assert _migration_files(), "未找到任何迁移 SQL；路径推断有误"


def test_no_hardcoded_database_name_in_grants() -> None:
    """`GRANT ... ON DATABASE <name>` 会把全新环境的库名写死，fresh deploy 必崩。"""
    offenders = []
    for f in _migration_files():
        code = _uncommented(f.read_text(encoding="utf-8"))
        if _ON_DATABASE.search(code):
            offenders.append(str(f.relative_to(_SERVER_ROOT)))
    assert not offenders, (
        "迁移里硬编码了数据库名（应由 apply_migrations 用 current_database() 动态授权）："
        f"{offenders}"
    )


def test_no_forcerowsecurity_pg_tables_column() -> None:
    """`pg_tables` 无 forcerowsecurity 列；ENABLE/FORCE RLS 幂等，无需该守卫。"""
    offenders = []
    for f in _migration_files():
        code = _uncommented(f.read_text(encoding="utf-8")).lower()
        if "forcerowsecurity" in code:
            offenders.append(str(f.relative_to(_SERVER_ROOT)))
    assert not offenders, (
        "迁移引用了不存在的 pg_tables.forcerowsecurity 列（全新库会报错）：" f"{offenders}"
    )
