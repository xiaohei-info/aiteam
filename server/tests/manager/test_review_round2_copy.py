"""PR #198 第 2 轮复审（复制专家）：复制路由不阻塞事件循环；0052 灰度修正每次部署都执行。"""

from __future__ import annotations

import inspect
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[2] / "manager_service" / "migrations"


def test_copy_route_runs_in_the_threadpool():
    """复制会同步读库、调运营端目录、复制头像文件：必须是普通函数，由框架放到线程池。"""
    from manager_service.routes_employee import build_employee_router
    from tests.manager._auth_helper import make_inmem_verifier_and_signer

    verifier, _ = make_inmem_verifier_and_signer()
    from fastapi.routing import APIRoute

    routes = build_employee_router(verifier).routes
    [route] = [r for r in routes if isinstance(r, APIRoute) and r.path.endswith("/copy")]
    assert not inspect.iscoroutinefunction(route.endpoint)


def test_0052_corrects_custom_experts_created_during_rollout_on_every_run():
    """迁移先于新代码上线：旧代码新建的自建专家拿到列默认值 recruited，每次部署都要修正。"""
    sql = (MIGRATIONS / "0052_employee_origin.sql").read_text(encoding="utf-8")
    after_do = sql.split("END $$;", 1)[1]
    assert "UPDATE employee SET origin = 'custom' WHERE origin = 'recruited' AND source_template_id IS NULL;" in after_do
