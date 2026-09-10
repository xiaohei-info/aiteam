"""企业端共享异常（02 §11 统一错误模型）。

控制面收端（F01/F02，routes_tenant / routes_bootstrap）共用的错误类型集中在此，
避免跨路由文件重复定义（#100 review M4）。
"""

from __future__ import annotations

from shared.errors import AppError


class ManagerAdminDbNotConfigured(AppError):
    """管理 DB 未配置（DB_URL/ADMIN_DB_URL 缺失）。统一 503 + problem+json，不静默。"""

    status = 503
    code = "manager_admin_db_unconfigured"
    title = "Manager Admin DB Unconfigured"


class ManagerControlPlaneUnavailable(AppError):
    """Manager control-plane schema/connection unavailable (typed 503)."""

    status = 503
    code = "manager_control_plane_unavailable"
    title = "Manager Control Plane Unavailable"
