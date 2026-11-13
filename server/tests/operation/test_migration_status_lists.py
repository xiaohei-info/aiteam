"""迁移没有版本表，每次部署都全量重跑：旧迁移里的状态清洗 / CHECK 必须认得枚举的全部取值。

否则新增的状态（如 deleting / deleted）会在下一次部署被旧迁移改回默认值。
"""

import re
from pathlib import Path

from shared.contracts.enums import EnterpriseOperationStatus

_MIGRATIONS = Path(__file__).resolve().parents[2] / "operation_service" / "migrations"
_STATUS_LIST = re.compile(r"operation_status\s+(?:NOT\s+)?IN\s*\(([^)]*)\)", re.IGNORECASE)


def _status_lists():
    for path in sorted(_MIGRATIONS.glob("*.sql")):
        body = "\n".join(line.split("--", 1)[0] for line in path.read_text(encoding="utf-8").splitlines())
        for match in _STATUS_LIST.finditer(body):
            yield path.name, set(re.findall(r"'([^']+)'", match.group(1)))


def test_every_operation_status_list_covers_the_whole_enum():
    expected = {status.value for status in EnterpriseOperationStatus}
    lists = list(_status_lists())
    assert lists, "expected at least one operation_status list in the migrations"
    incomplete = {name: sorted(expected - values) for name, values in lists if not expected <= values}
    assert not incomplete, f"迁移里的 operation_status 清单缺少取值（重跑会把这些状态改掉或建约束失败）：{incomplete}"
