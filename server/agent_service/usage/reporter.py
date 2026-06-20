"""outbox drain 上报器（A5，04 §6.5 可靠性 / 05 F13）。

把 outbox 中 pending 的脱敏摘要按 tenant 打包成 UsageSummaryUpload，经窄通道上报 Manager；
成功置 sent，失败留 pending（attempts+1、记 last_error）等下次 drain——不丢、可重试。

幂等：每条 outbox item 的 summary_id 既是 outbox 主键，也是上报的 Idempotency-Key 来源；
对端 Manager 按 summary_id 去重（契约语义）。一批上报用确定性 batch key 派生，重发同一批
得到同一 key。

尽力而为（D13）：drain 返回结果供观测，**不抛出**到调用方（不阻塞本地执行）。
"""

from __future__ import annotations

import hashlib

from shared.contracts.crosstier import UsageSummaryUpload
from shared.contracts.summary import AuditSummaryEvent, UsageSummary

from .client import ManagerUsageClient
from .store import OutboxItem, OutboxKind, OutboxRepository


class DrainResult:
    """一次 drain 的结果摘要（观测用）。"""

    def __init__(self, sent: int = 0, failed: int = 0, batches: int = 0) -> None:
        self.sent = sent
        self.failed = failed
        self.batches = batches

    def __repr__(self) -> str:  # pragma: no cover - 诊断用
        return f"DrainResult(sent={self.sent}, failed={self.failed}, batches={self.batches})"


def _batch_idempotency_key(tenant_id: str, items: list[OutboxItem]) -> str:
    """确定性批次幂等键：同一组 summary_id 重发得到同一 key。"""
    joined = "|".join(sorted(i.summary_id for i in items))
    digest = hashlib.sha256(f"{tenant_id}|{joined}".encode("utf-8")).hexdigest()[:24]
    return f"uup_{digest}"


class UsageReporter:
    """按 tenant 打包 + 上报 + 标记的 outbox drain 器。"""

    def __init__(self, *, outbox: OutboxRepository, client: ManagerUsageClient) -> None:
        self._outbox = outbox
        self._client = client

    def drain(self) -> DrainResult:
        """把所有 pending 摘要按 tenant 分组上报。尽力而为，不抛出。"""
        pending = self._outbox.list_pending()
        if not pending:
            return DrainResult()

        by_tenant: dict[str, list[OutboxItem]] = {}
        for item in pending:
            by_tenant.setdefault(item.tenant_id, []).append(item)

        result = DrainResult()
        for tenant_id, items in by_tenant.items():
            result.batches += 1
            payload = _build_payload(tenant_id, items)
            key = _batch_idempotency_key(tenant_id, items)
            try:
                self._client.upload(payload, idempotency_key=key)
            except Exception as exc:  # noqa: BLE001 — 尽力而为：失败留 pending 重试，不阻塞本地
                for item in items:
                    self._outbox.mark_failed(item.summary_id, str(exc))
                result.failed += len(items)
                continue
            for item in items:
                self._outbox.mark_sent(item.summary_id)
            result.sent += len(items)
        return result


def _build_payload(tenant_id: str, items: list[OutboxItem]) -> UsageSummaryUpload:
    usage: list[UsageSummary] = [i.usage for i in items if i.kind is OutboxKind.USAGE and i.usage]
    audits: list[AuditSummaryEvent] = [
        i.audit for i in items if i.kind is OutboxKind.AUDIT and i.audit
    ]
    return UsageSummaryUpload(tenant_id=tenant_id, usage=usage, audits=audits)
