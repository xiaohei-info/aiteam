"""Agent → Manager 摘要上报客户端（A5，05 §5.3 / F13）。

窄通道：用户端主动访问 Manager，按 UsageSummaryUpload 契约上报脱敏摘要。
- 协议接口 ManagerUsageClient.upload(payload) → 抛异常即视为失败（留 pending 重试）。
- 真实实现 ServiceClientUsageClient 复用 shared.service_client（服务身份 + Idempotency-Key）。
- A5 对端 Manager（M8/#42）尚未联调：默认 UnconfiguredUsageClient 安全拒绝（不静默成功）。
- 测试用 fake client（见 tests），不真连。

红线：payload 只能是 UsageSummaryUpload（脱敏契约）；本客户端不感知、不接受任何原始事件。
"""

from __future__ import annotations

from typing import Protocol

from shared.contracts.crosstier import UsageSummaryUpload
from shared.errors import AppError
from shared.service_client import ServiceClient

_UPLOAD_PATH = "/api/manager/usage/summary"


class ManagerUsageClient(Protocol):
    """摘要上报对端协议。upload 成功返回 None；失败抛异常。"""

    def upload(self, payload: UsageSummaryUpload, *, idempotency_key: str) -> None: ...


class UnconfiguredUsageClient:
    """未配置 manager_url 的安全默认：上报一律按"不可达"失败，留 pending 重试。

    避免缺配置时静默丢摘要或静默成功。生产须注入 ServiceClientUsageClient。
    """

    def upload(self, payload: UsageSummaryUpload, *, idempotency_key: str) -> None:
        raise AppError("manager usage client 未配置（A5 骨架）。配置 MANAGER_URL 并注入真实客户端后可用。")


class ServiceClientUsageClient:
    """经 shared.service_client 上报。写调用带 Idempotency-Key（05 §5.1），不自动重试——

    重试由 outbox（reporter.drain）按 summary_id 幂等驱动。
    """

    def __init__(self, client: ServiceClient) -> None:
        self._client = client

    def upload(self, payload: UsageSummaryUpload, *, idempotency_key: str) -> None:
        self._client.post(
            _UPLOAD_PATH,
            json=payload.model_dump(mode="json"),
            idempotency_key=idempotency_key,
        )
