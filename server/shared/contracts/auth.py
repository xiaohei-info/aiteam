"""认证身份契约（03 §9.3/§9.5，D8/D23）。

- token 单一出口：JWT，载荷 TokenClaims（必带 tenant_id）。
- 非对称签名：Manager 按 tenant 持私钥签发，Agent 只持公钥/JWKS 验签；
  禁止向用户端下发 HMAC 对称密钥（D23）。
- user / auth_identity 在各凭据持有端结构同构（03 §9.3）。

注意：本文件是**契约形状**，不含验签/签发实现（实现落 shared/auth，03）。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from .enums import AuthProvider


class TokenClaims(BaseModel):
    """JWT 载荷（03 §9.5）。校验由 shared/auth 本地无状态完成，不回调签发端。"""

    model_config = ConfigDict(extra="forbid")

    tenant_id: str | None = Field(
        default=None,
        description="租户 id（UUID 字符串）。Manager 签发必填；Operator 系统账号可空或 system tenant",
    )
    enterprise_id: str | None = Field(default=None)
    user_id: str = Field(description="规范账号 id（UUID 字符串）")
    roles: list[str] = Field(default_factory=list, description="EnterpriseRole/PlatformRole 取值")
    iss: str | None = Field(default=None, description="JWT issuer；Agent 生产验签必填")
    aud: str | list[str] | None = Field(default=None, description="JWT audience；Agent 生产验签必填")
    iat: int | None = Field(default=None, description="JWT issued-at Unix 秒")
    exp: int = Field(description="过期时间（Unix 秒）。短期 access token，过期需重新联网登录")


class UserPrincipal(BaseModel):
    """规范账号 user（principal）。Manager 内必须带 tenant_id（03 §9.3）。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    tenant_id: str | None = Field(default=None, description="Manager 内必填；身份是租户边界的一部分")
    enterprise_id: str | None = Field(default=None)
    display_name: str = ""
    status: str = "active"
    roles: list[str] = Field(default_factory=list)


class AuthIdentity(BaseModel):
    """外部身份 → 内部 user 的映射（03 §9.3）。一个 user 可挂 N 行。

    唯一约束 unique(tenant_id, provider, external_id)：同手机号可属不同企业，不能跨 tenant 串线。
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    user_id: str = Field(description="-> UserPrincipal.id")
    tenant_id: str | None = Field(default=None, description="Manager 内必填")
    provider: AuthProvider
    external_id: str = Field(description="phone=手机号 / password=用户名 / wechat=openid")
    secret: str | None = Field(
        default=None,
        description="password=hash；其它=null 或 provider 侧引用。禁止明文/可逆",
    )
