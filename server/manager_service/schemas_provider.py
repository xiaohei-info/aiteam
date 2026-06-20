"""provider 凭据/AI Relay 管理面 API 边界 schema（M5，04 §6.7，D18）。

红线（04 §6.7，D18）：
- 写入请求体（Create/Update）携带明文 secret（仅写入面，入参即焚——service 层加密后明文不落库）。
- 读取响应体（Out）**绝不**含明文 secret，也不含密文——只回 provider_ref + 非敏感元数据。
- provider_ref 语义：RunSpec 以 provider_ref 引用该配置（06 §7.5.1），不内联明文凭据。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ProviderCredentialBase(BaseModel):
    """provider 凭据的共享中立字段（不含 secret，避免被响应体误继承）。"""

    model_config = ConfigDict(extra="forbid")

    display_name: str = ""
    # mode：relay（默认，企业级令牌走 AI Relay）| direct（可选，直连 provider API key）（04 §6.7）。
    mode: Literal["relay", "direct"] = Field(default="relay")
    # endpoint：AI Relay 或直连 provider 的接入端点（非敏感，允许回显）。
    endpoint: str | None = Field(default=None)
    # 可见性：tenant（租户内全员可用）| members（仅 allowed_member_ids 列出的成员）。
    visibility: Literal["tenant", "members"] = Field(default="tenant")
    # 成员级授权真相态：visibility=members 时生效（app_user.id 列表）。
    allowed_member_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _members_requires_ids(self) -> "ProviderCredentialBase":
        if self.visibility == "members" and not self.allowed_member_ids:
            raise ValueError("visibility=members requires non-empty allowed_member_ids")
        return self


class ProviderCredentialCreate(ProviderCredentialBase):
    """创建请求体。provider_ref（租户内唯一）+ 明文 secret（入参即焚）。"""

    provider_ref: str = Field(description="租户内唯一 provider 引用（RunSpec 以此引用，06 §7.5.1）")
    # 明文 secret：AI Relay 企业级令牌 或 直连 provider API key。service 层加密后明文不落库/不日志。
    secret: str = Field(description="明文凭据（AI Relay 令牌或 provider API key）；入库前加密，不回显")


class ProviderCredentialUpdate(ProviderCredentialBase):
    """改写请求体。provider_ref 不可改（引用稳定性）；secret 全量替换。"""

    secret: str = Field(description="明文凭据（全量替换；入库前加密，不回显）")


class ProviderCredentialOut(BaseModel):
    """读取响应体。**绝不含明文 secret / 密文**（红线：不下发明文 key）。

    只回 provider_ref + 非敏感元数据（endpoint/可见性/version），供配置管理 UI 与增量 sync。
    用户端 pull 已授权 provider 配置时，由独立的受控 pull 通道下发（解密由 Driver 最小注入），
    本 CRUD 出参面向管理面，不下发任何形态的凭据。
    """

    model_config = ConfigDict(extra="forbid")

    credential_id: str
    provider_ref: str
    display_name: str
    mode: str
    endpoint: str | None
    visibility: str
    allowed_member_ids: list[str] = Field(default_factory=list)
    version: int = Field(description="配置版本；每次变更单调递增")
