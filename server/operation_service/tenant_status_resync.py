"""一次性运维命令：把 Operator 里非 active 企业的状态补同步到 Manager。

背景：企业状态联动 Manager 是后加的能力，只在状态变化时触发；上线前就已暂停 / 封禁 / 注销的企业，
Manager 侧仍是 active（成员照常能登录）。上线后执行一次本命令即可，幂等，可重复执行。

用法（与 Operation 服务相同的环境变量，Manager 须已升级到支持 /tenants/{id}/status 的版本）：
    python -m operation_service.tenant_status_resync
输出一行 JSON：{"synced": N, "failed": [{"enterprise_id", "status", "error"}]}；有失败项时退出码为 1。
"""

from __future__ import annotations

import json
import sys

from .admin_dependencies import get_admin_service


def main(argv: list[str] | None = None) -> int:
    result = get_admin_service().resync_tenant_statuses()
    print(json.dumps(result, ensure_ascii=False))
    return 1 if result["failed"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
