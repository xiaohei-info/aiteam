"""0057 迁移每次部署都会重跑：清理只能命中旧实现写的行，不能误删新代码写的头像。

回归 PR #231 复核：原写法 ``DELETE ... WHERE avatar_url IS NOT NULL`` 在「代码回滚 → 再部署」时
依赖 avatar_url 是否为空，属于无标记的清空数据；改为按新代码固定的 storage_key 判定。
真实 PostgreSQL 上的行为（旧行删除、新行保留、重跑幂等）已在 PR 描述中记录。
"""

import re
from pathlib import Path

MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "manager_service" / "migrations" / "0057_employee_avatar_file.sql"
)


def _sql() -> str:
    text = MIGRATION.read_text(encoding="utf-8")
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines())


def test_delete_targets_only_non_canonical_storage_keys():
    sql = " ".join(_sql().split())
    deletes = re.findall(r"DELETE FROM employee_avatar[^;]*;", sql, re.IGNORECASE)
    assert len(deletes) == 1
    assert (
        "storage_key IS DISTINCT FROM 'avatars/' || tenant_id::text || '/' || employee_id::text || '.webp'"
        in deletes[0]
    ), "清理条件必须是「storage_key 不是新代码的固定路径」，否则会删掉新代码写的头像"
    assert "avatar_url" not in deletes[0], "不能再依赖 avatar_url 判定，代码回滚后会误删"


def test_canonical_path_matches_service():
    service = (Path(__file__).resolve().parents[2] / "manager_service" / "employee_avatar_service.py").read_text(
        encoding="utf-8"
    )
    assert 'f"avatars/{ctx.tenant_id}/{employee_id}.webp"' in service, (
        "服务端头像路径变了，0057 的清理条件要同步修改"
    )
