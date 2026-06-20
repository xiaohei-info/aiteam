"""A5 命门：无会话内容上传断言（D13 / CLAUDE §3.3 / 04 §6.5）。

构造夹带会话文本、prompt/completion、provider key 的本地原始事件，走完整链路
（record → aggregate → outbox → upload），断言上报到 Manager 的 payload 中**绝不出现**
任何敏感文本。这是本卡最硬的隐私护栏测试。
"""

import json

from agent_service.usage.factory import build_usage_service
from agent_service.usage.models import RawAuditEvent, RawUsageEvent
from shared.contracts.crosstier import UsageSummaryUpload

# 在原始事件里埋入的敏感哨兵串——上报 payload 中一个都不许出现。
SECRET_PROMPT = "用户的私密会话内容：我的银行卡密码是123456"
SECRET_COMPLETION = "助手回复了一段绝密的商业方案明细文本"
SECRET_PROVIDER_KEY = "sk-live-PROVIDER-SECRET-KEY-must-not-leak"
SECRET_FILE = "/Users/alice/secret-merger-deck.pdf"
SENTINELS = [SECRET_PROMPT, SECRET_COMPLETION, SECRET_PROVIDER_KEY, SECRET_FILE]


class CapturingUsageClient:
    """fake 对端：捕获每次上报的 payload，不真连 Manager。"""

    def __init__(self) -> None:
        self.uploads: list[UsageSummaryUpload] = []

    def upload(self, payload: UsageSummaryUpload, *, idempotency_key: str) -> None:
        self.uploads.append(payload)


def _raw_events_laced_with_secrets() -> list[RawUsageEvent]:
    """原始 usage 事件，刻意夹带会话文本/prompt/completion/provider key/文件路径。

    RawUsageEvent extra='allow'，这些敏感字段确实进入了本地原始事件——正是要验证它们
    不会流到上报 payload。
    """
    return [
        RawUsageEvent(
            run_id="r1",
            employee_id="e1",
            usage={
                "input_tokens": 12,
                "output_tokens": 8,
                "cost": "0.05",
                # 即便 usage dict 里混入了敏感文本，也不该被带出
                "prompt": SECRET_PROMPT,
                "provider_key": SECRET_PROVIDER_KEY,
            },
            # 顶层透传的会话上下文（extra 字段）
            prompt=SECRET_PROMPT,
            completion=SECRET_COMPLETION,
            messages=[{"role": "user", "content": SECRET_PROMPT}],
            file_path=SECRET_FILE,
        ),
    ]


def test_uploaded_payload_contains_no_session_content():
    client = CapturingUsageClient()
    service = build_usage_service(client=client)

    service.record_usage("t1", _raw_events_laced_with_secrets())
    service.record_audits("t1", [
        RawAuditEvent(actor="u1", action="login", note=SECRET_PROMPT),  # extra note 夹带
    ])
    result = service.flush()

    assert result.sent >= 1
    assert client.uploads, "应至少有一次上报"

    # 把所有上报 payload 序列化为 JSON，逐哨兵断言不出现。
    blob = json.dumps([p.model_dump(mode="json") for p in client.uploads], ensure_ascii=False)
    for secret in SENTINELS:
        assert secret not in blob, f"上报 payload 泄露了敏感内容: {secret!r}"


def test_payload_only_carries_metering_and_audit_fields():
    """正向：上报 payload 只含契约定义的计量/审计字段，计量值正确。"""
    client = CapturingUsageClient()
    service = build_usage_service(client=client)
    service.record_usage("t1", _raw_events_laced_with_secrets())
    service.flush()

    payload = client.uploads[0]
    assert isinstance(payload, UsageSummaryUpload)
    assert payload.tenant_id == "t1"
    assert len(payload.usage) == 1
    s = payload.usage[0]
    assert s.token_total == 20  # 12 + 8，与脱敏前计量一致
    # UsageSummary extra='forbid'：契约本身就拒绝携带额外（敏感）字段
    assert set(s.model_dump().keys()) == {
        "summary_id", "tenant_id", "employee_id", "window_start", "window_end",
        "run_count", "token_total", "cost_total", "error_count", "duration_seconds_total",
    }
