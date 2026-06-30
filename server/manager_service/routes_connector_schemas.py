"""Connector route Pydantic schemas (B05)."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ConnectorStatusOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connector_id: str
    status: str
    last_check_at: datetime | None = None
    error_message: str | None = None


class ConnectorTestResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connector_id: str
    success: bool
    latency_ms: int = 0
    message: str = ""
    auth_scheme: str | None = None
    flow: str | None = None


class ConnectorTestIn(BaseModel):
    """Body for POST /api/manager/connectors/{id}/test.

    Operator provides the connector definition fields known at registration time;
    Manager validates them locally (no outbound calls per D18) and records the result.
    """
    model_config = ConfigDict(extra="forbid")
    auth_scheme: str | None = None
    config_schema_json: str | dict | None = None


class ConnectorGrantsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_ids: list[str] = []
    action: str = "grant"


class ConnectorPreset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preset_id: str
    name: str
    type: str
    icon: str | None = None
    description: str = ""


PRESETS: list[ConnectorPreset] = [
    ConnectorPreset(preset_id="feishu", name="飞书", type="preset_oauth", icon="feishu", description="飞书办公协作"),
    ConnectorPreset(preset_id="dingtalk", name="钉钉", type="preset_oauth", icon="dingtalk", description="钉钉办公协作"),
    ConnectorPreset(preset_id="wecom", name="企业微信", type="preset_oauth", icon="wecom", description="企业微信"),
    ConnectorPreset(preset_id="salesforce", name="Salesforce", type="preset_oauth", icon="salesforce", description="CRM"),
    ConnectorPreset(preset_id="jira", name="Jira", type="preset_apikey", icon="jira", description="项目管理"),
    ConnectorPreset(preset_id="github", name="GitHub", type="preset_oauth", icon="github", description="代码托管"),
    ConnectorPreset(preset_id="slack", name="Slack", type="preset_oauth", icon="slack", description="团队沟通"),
    ConnectorPreset(preset_id="google", name="Google Workspace", type="preset_oauth", icon="google", description="Google 办公套件"),
]
