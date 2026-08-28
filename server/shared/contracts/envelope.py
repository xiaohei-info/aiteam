"""北向响应 envelope 与统一错误模型（02 §10.3.4 / §11.2，D2/D10）。

- 成功响应：单对象 Envelope，列表 ListEnvelope（带 page）。不得自造 {ok:true}/{success:true}。
- 错误响应：application/problem+json（Problem）。`message` 不作顶层字段（用 detail）。
- 错误体禁止含密码/token/provider key/会话内容/raw event（02 §11.2，CLAUDE/AGENTS §13）。
"""

from __future__ import annotations

from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class Page(BaseModel):
    """列表分页（02 §10.3.7）。对外只暴露 numeric/opaque cursor，禁暴露内部 {ts}-{seq}。"""

    model_config = ConfigDict(extra="forbid")

    next_cursor: str | None = Field(default=None, description="下一页游标；None 表示无更多")
    has_more: bool = Field(default=False)


class Envelope(BaseModel, Generic[T]):
    """单对象成功响应：{ "data": <object>, "meta": {...}? }（02 §10.3.4）。"""

    model_config = ConfigDict(extra="forbid")

    data: T | None = Field(default=None, description="业务对象；空成功可为 null")
    meta: dict[str, Any] | None = Field(default=None, description="非敏感诊断信息，可选")


class ListEnvelope(BaseModel, Generic[T]):
    """列表成功响应：{ "data": [...], "page": {...}, "meta": {...}? }（02 §10.3.4）。"""

    model_config = ConfigDict(extra="forbid")

    data: list[T] = Field(default_factory=list)
    page: Page = Field(default_factory=Page)
    meta: dict[str, Any] | None = Field(default=None, description="非敏感诊断信息，可选")


class ProblemFieldError(BaseModel):
    """problem+json 的字段级校验错误项（02 §11.2 的 errors[]）。"""

    model_config = ConfigDict(extra="forbid")

    loc: list[str | int] = Field(description="字段路径，如 ['body','display_name']")
    message: str
    type: str = Field(description="错误类型，如 'missing'")


class Problem(BaseModel):
    """application/problem+json 统一错误模型（02 §11.2，单一事实源）。

    由各端入口中间件 / FastAPI exception handler / service_client 统一生成与解码；
    各端不得自定义错误形态。
    """

    model_config = ConfigDict(extra="forbid")

    type: str = Field(description="错误类型 URI，如 https://docs.aiteam.local/problems/validation_error")
    title: str
    status: int = Field(description="HTTP 状态码（401/403/404/409/422/429/...）")
    code: str = Field(description="机器可读错误码，如 validation_error")
    detail: str | None = Field(default=None, description="人读说明；前端统一展示此字段")
    instance: str | None = Field(default=None, description="出错的资源路径")
    request_id: str | None = Field(default=None, description="调试关联 id")
    errors: list[ProblemFieldError] | None = Field(default=None, description="字段级校验错误")
    meta: dict[str, Any] | None = Field(default=None, description="非敏感诊断信息")
