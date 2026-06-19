"""运营端北向 API 边界 schema（02 §10.3，Pydantic 作 API 边界）。

仅声明本端 HTTP 请求/响应形状；跨端契约（TenantProvisionRequest/OwnerBootstrapSync）一律
从 shared.contracts.crosstier import，**禁在此重定义**。

响应里的 bootstrap_secret 是**一次性明文**，仅在签发/重置当次返回给系统操作员转交负责人；
Operator 自身只持其 hash（03 §9.2）。响应体不含长期密码、token、provider key。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class ProvisionEnterpriseRequest(BaseModel):
    """F01 开通企业（北向请求）：系统操作员发起。"""

    model_config = ConfigDict(extra="forbid")

    enterprise_name: str = Field(min_length=1)
    owner_phone: str = Field(min_length=1, description="负责人手机号，用于 Manager 校验登录身份")
    enterprise_code: str | None = Field(default=None, description="可读 slug，可选，需唯一")
    initial_quota_policy: dict | None = Field(default=None)
    visible_catalog_policy: dict | None = Field(default=None)


class EnterpriseProvisioned(BaseModel):
    """F01/F02 开通结果（北向响应）。bootstrap_secret 一次性明文，仅当次返回。"""

    model_config = ConfigDict(extra="forbid")

    enterprise_id: str
    tenant_id: str
    enterprise_name: str
    enterprise_code: str | None = None
    owner_phone: str
    owner_bootstrap_secret: str = Field(description="一次性明文 bootstrap，仅本次返回；Operator 只持 hash")
    must_reset: bool = Field(default=True, description="负责人首登强制重置")


class OwnerBootstrapResetResult(BaseModel):
    """F02 负责人凭据重置结果（北向响应）。返回新的一次性明文 bootstrap。"""

    model_config = ConfigDict(extra="forbid")

    enterprise_id: str
    tenant_id: str
    owner_phone: str
    owner_bootstrap_secret: str = Field(description="重置后的一次性明文 bootstrap，仅本次返回")
    must_reset: bool = Field(default=True)
