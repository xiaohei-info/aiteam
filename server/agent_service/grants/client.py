"""Agent → Manager 授权配置 / 执行快照 pull 客户端（A4，05 F10/F11 / D12/D5）。

窄通道：用户端**主动访问** Manager（无入站、无推送）。两类只读 pull：
- pull_authorized_config(F10)：带本地投影版本/etag，Manager 回增量（按 tenant + member_grant 裁剪）。
- pull_snapshot(F11)：提交 run 前按 employee_id+version 拉 EmployeeExecutionSnapshot。

约定：
- 协议接口 ManagerGrantsClient.* → 抛异常即视为对端不可达/失败（由 service 降级处理）。
- 真实实现 ServiceClientGrantsClient 复用 shared.service_client（服务身份 + trace 透传）。
- 对端 Manager（M7/#41）尚未联调：默认 UnconfiguredGrantsClient 安全拒绝（不静默成功）。
- 测试用 fake client（见 tests），不真连。

红线：只读 pull；本客户端不向 Manager 写任何配置主数据（单写者是 Manager）。
"""

from __future__ import annotations

from typing import Protocol

from shared.contracts.crosstier import (
    AuthorizedConfigPullRequest,
    AuthorizedConfigPullResponse,
    SnapshotPullRequest,
    SnapshotPullResponse,
)
from shared.errors import AppError
from shared.service_client import ServiceClient

_CONFIG_PATH = "/api/manager/grants/authorized-config"
_SNAPSHOT_PATH = "/api/manager/grants/snapshot"


class ManagerGrantsClient(Protocol):
    """授权配置 / 快照 pull 对端协议。成功返回响应；不可达/失败抛异常。"""

    def pull_authorized_config(
        self, request: AuthorizedConfigPullRequest
    ) -> AuthorizedConfigPullResponse: ...

    def pull_snapshot(self, request: SnapshotPullRequest) -> SnapshotPullResponse: ...


class UnconfiguredGrantsClient:
    """未配置 manager_url 的安全默认：pull 一律按"不可达"失败。

    避免缺配置时静默成功/落空投影。生产须注入 ServiceClientGrantsClient。
    本地降级语义（D14）由 GrantsService 处理：pull 失败不影响已有投影 + 已冻结快照。
    """

    def pull_authorized_config(
        self, request: AuthorizedConfigPullRequest
    ) -> AuthorizedConfigPullResponse:
        raise AppError("manager grants client 未配置（A4 骨架）。配置 MANAGER_URL 并注入真实客户端后可用。")

    def pull_snapshot(self, request: SnapshotPullRequest) -> SnapshotPullResponse:
        raise AppError("manager grants client 未配置（A4 骨架）。配置 MANAGER_URL 并注入真实客户端后可用。")


class ServiceClientGrantsClient:
    """经 shared.service_client 主动 pull。只读 GET 可幂等重试（service_client 内置）。"""

    def __init__(self, client: ServiceClient) -> None:
        self._client = client

    def pull_authorized_config(
        self, request: AuthorizedConfigPullRequest
    ) -> AuthorizedConfigPullResponse:
        body = self._client.post(_CONFIG_PATH, json=request.model_dump(mode="json"))
        return AuthorizedConfigPullResponse.model_validate(body)

    def pull_snapshot(self, request: SnapshotPullRequest) -> SnapshotPullResponse:
        body = self._client.post(_SNAPSHOT_PATH, json=request.model_dump(mode="json"))
        return SnapshotPullResponse.model_validate(body)
