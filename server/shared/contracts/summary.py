"""脱敏治理摘要（04 §6.5，D13）。

替代跨端 usage 事件：会话内容/执行明细/逐 token 明细**绝不上传**；治理闭环靠脱敏聚合摘要
逐级上报 Agent → Manager（enterprise_usage_rollup）→ Operator（cross_enterprise_usage_rollup）。

铁律：脱敏在用户端**上报前**完成；不含会话文本、文件、工具输入输出明细。
按 summary_id 幂等去重；上报尽力而为，不阻塞本地执行。具体字段清单留详设（00 §20.2）。
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class UsageSummary(BaseModel):
    """计量摘要（按员工/专家/时间聚合）。金额用 Decimal，token 用 int，禁 float（02 §10.3.5）。"""

    model_config = ConfigDict(extra="forbid")

    summary_id: str = Field(description="幂等键")
    tenant_id: str
    employee_id: str | None = Field(default=None, description="员工 id（UUID 字符串）")
    window_start: datetime
    window_end: datetime
    run_count: int = 0
    token_total: int = 0
    cost_total: Decimal = Field(default=Decimal("0"), description="USD 总费用（至少 6 位小数）")
    currency: Literal["USD"] = "USD"
    pricing_version: int | None = Field(default=None, ge=1)
    pricing_status: Literal["known", "unknown"] = "unknown"
    error_count: int = 0
    duration_seconds_total: int = 0


class AuditSummaryEvent(BaseModel):
    """关键审计事件摘要（招募装载/登录/授权变更/越权尝试）。带 tenant_id，**不含会话内容**。"""

    model_config = ConfigDict(extra="forbid")

    summary_id: str = Field(description="幂等键")
    tenant_id: str
    actor: str = Field(description="user_id 或服务身份")
    action: str = Field(description="如 expert_load / login / grant_change / unauthorized_attempt")
    resource_type: str | None = Field(default=None, description="资源类型：expert/solution 等")
    resource_id: str | None = Field(default=None, description="资源 id")
    occurred_at: datetime
